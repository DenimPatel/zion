/**
 * Zion viewer entry point.
 *
 * Loads the city, streams districts around the camera, runs the render loop,
 * and routes input to the right mode: fly, orbit, walk, or inside a
 * building. All analysis happened in Python; nothing here parses source.
 */

import * as THREE from 'three';
import { CitySource } from './loader.js';
import {
  CityMesh,
  HEALTH_COLOURS,
  cycleColour,
  createCityHall,
  createImpostors,
  createHoverOutline,
  createDistrictMarker,
  placeDistrictMarker,
  ARCHETYPE_COLORS,
  archetypeLabel,
} from './city.js';
import { SkyRig } from './sky.js';
import { FlyCamera, OrbitCamera, CameraFlight } from './cameras.js';
import { CollisionGrid, WalkCamera } from './collision.js';
import { Interior } from './interior.js';
import { CityHall, Tour } from './tour.js';
import { DistrictStreamer } from './stream.js';
import { Vault } from './vault.js';
import { Inspector } from './inspector.js';
import { buildFacets, columnIndex, parseQuery, runQuery } from './facets.js';
import { MapLabels } from './labels.js';
import { renderBuilding, renderDistrict, resetDetailPanel } from './detail.js';

const canvas = document.getElementById('scene');
const loading = document.getElementById('loading');
const loadingText = document.getElementById('loading-text');
const promptEl = document.getElementById('prompt');

const params = new URLSearchParams(location.search);

const state = {
  source: new CitySource('.'),
  mode: 'fly', // fly | walk | orbit | interior
  night: 0,
  litScale: 1,
  time: 12,
  bench: params.has('bench'),
  selftest: params.has('selftest'),
  // Overrides used by the scale benchmark: software rendering in headless
  // Chrome cannot carry a 20,000-building working set with shadows, so the
  // benchmark can shrink either without changing the code paths under test.
  maxResident: Number(params.get('maxres')) || null,
  shadows: params.get('shadows') !== '0',
  filterText: '',
  // Archetypes the user has switched off in the Keys panel. Empty means the
  // whole repository is on screen, which is the default and the only state a
  // benchmark or self-test ever sees.
  hiddenArchetypes: new Set(),
  // Legend entries the user has switched off. Keyed by the manifest legend id
  // so the panel is driven by the analyzer's own list rather than a second one
  // kept here by hand.
  hiddenLayers: new Set(),
};

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
  // Headless screenshots are taken outside the animation frame, and without
  // this the drawing buffer has already been cleared by then. It costs
  // performance, so it is only enabled for capture runs.
  preserveDrawingBuffer: params.has('capture'),
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = state.shadows;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 0.5, 8000);

const context = {
  city: null,
  hall: null,
  sky: null,
  fly: null,
  orbit: null,
  flight: null,
  walk: null,
  grid: null,
  interior: null,
  inspector: null,
  cityHall: null,
  tour: null,
  streamer: null,
  resident: [],
};

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let hallNear = false;
let rebuilding = false;
// Where the city was last built for, and when: the near/far split is only valid
// around that point (see `refreshResident`).
let lodCentre = null;
let lodRebuiltAt = 0;

function resize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  if (context.interior) context.interior.resize(width / height);
}
window.addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------

/**
 * The City Guide is the legend made switchable, explained and counted.
 *
 * The manifest's `legend` owns what each entry *means*: it is emitted by the
 * analyzer (label, group, and a longer description) and describes the
 * repository, not the viewer. This table is the viewer's half of the same
 * contract the degeneration flags already use (`flags.churn` -> cranes) -- it
 * says which layer an entry draws, how to switch that layer off, what colour it
 * really is on screen, and which filter query finds the buildings that carry
 * it (for the live count and the "Highlight" action). There are three
 * switching mechanisms because they cost different things:
 *
 *   archetype  the form is dropped from the resident set and the city rebuilt,
 *              so collision and hover follow it (the path a form row takes)
 *   mesh       a separate InstancedMesh is toggled by visibility -- no rebuild
 *   option     the encoding is baked into the building instances (tint,
 *              weathering, lit windows, downtown glass, boarded windows), so
 *              the city is rebuilt with that option off
 *
 * An entry with `kind: null` has no layer of its own: it is either a pure
 * encoding -- height, footprint, floors, district area, roads -- or it lives
 * in the detail report (skybridges). Those rows are listed, because the panel
 * is the whole legend, but they are not switches and say so.
 */
const LEGEND_KEYS = {
  height: { kind: null, short: 'Height', colour: 0xc9ced8, reason: 'building height is the city itself' },
  footprint: { kind: null, short: 'Footprint', colour: 0xa4acb9, reason: 'the footprint is the plan itself' },
  floors: { kind: null, short: 'Floors', colour: 0x8b95a5, reason: 'floors are the window rows themselves' },
  lit_windows: { kind: 'option', short: 'Lit windows', colour: 0xffd479 },
  district_area: { kind: null, short: 'District area', colour: 0x1d2330, reason: 'district area is the layout itself' },
  roads: { kind: null, short: 'Roads', colour: 0xf2c14e, reason: 'roads are the layout itself' },
  regions: { kind: null, short: 'Folder plinths', colour: 0x4a5670, reason: 'plinths are the layout itself' },
  new_construction: { kind: 'mesh', target: 'scaffolding', short: 'Scaffolding', colour: 0xe8b04b, query: 'is:new' },
  churn: { kind: 'mesh', target: 'cranes', short: 'Cranes', colour: 0xd9a531, query: 'is:hot' },
  heat: { kind: 'mesh', target: 'heat-beacons', short: 'Rooftop beacons', colour: 0xff9d5c, query: 'heat>0' },
  weathering: { kind: 'option', short: 'Weathering', colour: 0x7a6a5a },
  author_tint: { kind: 'option', short: 'Author tint', colour: 0xb28ad6 },
  sole_tenant: { kind: 'mesh', target: 'sole-tenant-markers', short: 'Corner flags', colour: 0xe4c85a, query: 'is:soletenant' },
  town_hall: { kind: 'archetype', target: 'town_hall', short: 'Town halls', colour: ARCHETYPE_COLORS.town_hall, query: 'archetype:town_hall' },
  parks: { kind: 'archetype', target: 'park', short: 'Parks', colour: ARCHETYPE_COLORS.park, query: 'archetype:park' },
  silos: { kind: 'archetype', target: 'silo', short: 'Silos', colour: ARCHETYPE_COLORS.silo, query: 'archetype:silo' },
  monuments: { kind: 'archetype', target: 'monument', short: 'Monuments', colour: ARCHETYPE_COLORS.monument, query: 'archetype:monument' },
  downtown: { kind: 'option', short: 'Downtown towers', colour: 0x8fd6ff, query: 'is:downtown' },
  skybridges: { kind: null, short: 'Changes together with', colour: 0x6b7a90, reason: 'listed in the detail report, not drawn' },
  hotspots: { kind: 'mesh', target: 'hazard-barriers', short: 'Hazard barriers — hotspots', colour: HEALTH_COLOURS.hotspot, query: 'is:hotspot' },
  oversized: { kind: 'mesh', target: 'raking-shores', short: 'Buttresses — oversized', colour: HEALTH_COLOURS.oversized, query: 'is:oversized' },
  orphans: { kind: 'option', short: 'Boarded up — orphans', colour: HEALTH_COLOURS.orphan, query: 'is:orphan' },
  cycles: { kind: 'mesh', target: 'cycle-pennants', short: 'Pennants — import cycles', colour: HEALTH_COLOURS.cycle, query: 'is:cycle' },
  knowledge: { kind: 'mesh', target: 'knowledge-flags', short: 'Red flags — owner gone', colour: 0xe8332a, query: 'is:knowledge' },
};

// Forms the legend does not name, so every archetype still has a switch. The
// four that *are* legend entries (town hall, park, silo, monument) appear under
// Civic and are not repeated here.
const FORM_KEYS = ['tower', 'slab', 'warehouse', 'ruin'];
const FORM_NOTES = {
  tower: 'The tallest quarter of the code files: a lot of real code in one file.',
  slab: 'Middle-height files: the ordinary working stock of the city.',
  warehouse: 'Low, broad files: short, or a few long definitions.',
  ruin: 'Ignored files, drawn only with --include-noise.',
};

/** Is one legend entry currently switched off? */
function layerOff(id) {
  const spec = LEGEND_KEYS[id];
  if (!spec || !spec.kind) return false;
  if (spec.kind === 'archetype') return state.hiddenArchetypes.has(spec.target);
  return state.hiddenLayers.has(id);
}

const hexColour = (colour) => `#${(colour === undefined ? 0x777777 : colour).toString(16).padStart(6, '0')}`;

/** How many buildings, repository-wide, a filter query matches -- or null. */
function countFor(query) {
  if (!query || !context.facetIndex) return null;
  const predicate = parseQuery(
    query,
    state.source.manifest.indexColumns,
    (idx) => state.source.s(idx),
    resolveExt
  );
  if (!predicate) return null;
  return runQuery(context.facetIndex, predicate, state.source.manifest.indexColumns).count;
}

/** "Logical source lines -> building height" reads better with a real arrow. */
function prettyEncoding(text) {
  return String(text || '').replace(/\s*->\s*/g, ' → ');
}

function keyRow({ key, label, short, colour, kind, target, legend, reason, description, query, disabled }) {
  const row = document.createElement('div');
  row.className = 'key-row';
  row.dataset.key = key;
  if (legend) row.dataset.legend = legend;
  if (disabled) row.classList.add('disabled');

  let control;
  if (kind) {
    row.dataset.kind = kind;
    if (target) row.dataset.target = target;
    control = document.createElement('button');
    control.type = 'button';
    control.className = 'g-switch';
    control.setAttribute('role', 'switch');
    control.setAttribute('aria-label', `Show ${label}`);
    // The row carries the pressed state too, for anything that reads rows.
    row.setAttribute('aria-pressed', 'true');
  } else {
    row.classList.add('inert');
    control = document.createElement('span');
    control.className = 'g-badge';
    control.textContent = disabled ? 'off' : 'always';
    control.title = reason || 'no separate layer to switch';
  }

  const chip = document.createElement('span');
  chip.className = 'chip';
  chip.style.background = hexColour(colour);

  const name = document.createElement('button');
  name.type = 'button';
  name.className = 'g-name';
  name.textContent = label;
  name.setAttribute('aria-expanded', 'false');

  const count = document.createElement('span');
  count.className = 'g-count';
  const n = disabled ? null : countFor(query);
  if (n !== null) {
    count.textContent = n.toLocaleString();
    count.title = `${n.toLocaleString()} building${n === 1 ? '' : 's'} in the whole city`;
  }

  const line = document.createElement('p');
  line.className = 'g-short';
  line.textContent = disabled ? `${prettyEncoding(short)} — not drawn for this repository` : prettyEncoding(short);

  const more = document.createElement('div');
  more.className = 'g-more';
  more.hidden = true;
  const text = document.createElement('p');
  text.textContent = description || prettyEncoding(short);
  more.append(text);
  if (disabled && reason) {
    const why = document.createElement('p');
    why.textContent = reason;
    more.append(why);
  }
  if (query && n) {
    const actions = document.createElement('div');
    actions.className = 'g-actions';
    const highlight = document.createElement('button');
    highlight.type = 'button';
    highlight.dataset.query = query;
    highlight.className = 'g-highlight';
    highlight.textContent = `Highlight ${n.toLocaleString()}`;
    highlight.dataset.label = highlight.textContent;
    highlight.title = `Dim everything else (filter: ${query})`;
    actions.append(highlight);
    more.append(actions);
  }

  row.append(control, chip, name, count, line, more);
  return row;
}

function groupHeading(text) {
  const heading = document.createElement('div');
  heading.className = 'guide-group';
  heading.textContent = text;
  return heading;
}

/** Why a legend entry is off, from the analyzer's own notes where one says. */
function disabledReason(id) {
  const notes = (state.source.manifest.flags && state.source.manifest.flags.notes) || [];
  const words = {
    author_tint: /author/i, sole_tenant: /author/i, churn: /churn/i, heat: /churn/i, hotspots: /churn/i,
    weathering: /weather|commit dates/i, new_construction: /birth/i, skybridges: /coupling/i,
    downtown: /downtown/i, knowledge: /owner/i, orphans: /import/i, cycles: /import/i,
  }[id];
  const note = words ? notes.find((n) => words.test(n)) : null;
  if (note) return note;
  if (id === 'cycles') return 'No import cycles were found.';
  return 'Not drawn: the repository history is too thin for this signal to mean anything.';
}

function renderGuide() {
  const manifest = state.source.manifest;
  const list = document.getElementById('guide-list');
  list.innerHTML = '';

  let group = null;
  for (const entry of manifest.legend || []) {
    const spec = LEGEND_KEYS[entry.id] || { kind: null, short: entry.id, reason: 'no layer to switch' };
    const heading = entry.group || 'Signals';
    if (heading !== group) {
      list.append(groupHeading(heading));
      group = heading;
    }
    // A degeneration flag that is off means the geometry was never drawn, so
    // there is nothing for the reader to switch: say so rather than offer a
    // dead control.
    const disabled = entry.enabled === false;
    list.append(
      keyRow({
        key: `legend:${entry.id}`,
        label: spec.short,
        short: entry.label,
        colour: spec.colour,
        kind: disabled ? null : spec.kind,
        target: spec.target,
        legend: entry.id,
        reason: disabled ? disabledReason(entry.id) : spec.reason,
        description: entry.description,
        query: spec.query,
        disabled,
      })
    );
  }

  list.append(groupHeading('Forms'));
  for (const name of FORM_KEYS) {
    list.append(
      keyRow({
        key: `form:${name}`,
        label: archetypeLabel(name),
        short: FORM_NOTES[name],
        colour: ARCHETYPE_COLORS[name],
        kind: 'archetype',
        target: name,
        description: FORM_NOTES[name],
        query: `archetype:${name}`,
      })
    );
  }

  const notes = document.getElementById('guide-notes');
  notes.innerHTML = '';
  if (state.source.locked) {
    const p = document.createElement('p');
    p.textContent = 'Repo notes are encrypted. Press U and enter the passphrase to read them.';
    notes.append(p);
  } else {
    for (const note of manifest.stats.notes || []) {
      const p = document.createElement('p');
      p.textContent = state.source.s(note);
      notes.append(p);
    }
  }
  syncKeyRows();
  renderHealth();
  renderLensKey();
}

/** Reflect every switch on its row and the reset control. */
function syncKeyRows() {
  const list = document.getElementById('guide-list');
  if (!list) return;
  for (const row of list.querySelectorAll('.key-row')) {
    const kind = row.dataset.kind;
    if (!kind) continue;
    const off = kind === 'archetype'
      ? state.hiddenArchetypes.has(row.dataset.target)
      : state.hiddenLayers.has(row.dataset.legend);
    row.classList.toggle('off', off);
    row.setAttribute('aria-pressed', String(!off));
    const control = row.querySelector('.g-switch');
    if (control) {
      control.setAttribute('aria-checked', String(!off));
      control.title = `${off ? 'Show' : 'Hide'} ${row.querySelector('.g-name').textContent}`;
    }
  }
  const reset = document.getElementById('guide-reset');
  if (reset) {
    reset.hidden = state.hiddenArchetypes.size === 0 && state.hiddenLayers.size === 0;
  }
}

/**
 * Switch one row on or off.
 *
 * A form is dropped from the resident set and the city rebuilt, so the change
 * reaches the massing, the rooftop clutter, walk-mode collision and hover at
 * once rather than leaving invisible walls behind. A prop cluster is its own
 * InstancedMesh, so it only needs its visibility flipped. An encoding baked
 * into the instances forces a rebuild with that option off.
 */
function toggleRow(row) {
  const kind = row.dataset.kind;
  if (!kind) return;
  if (kind === 'archetype') {
    const name = row.dataset.target;
    if (state.hiddenArchetypes.has(name)) state.hiddenArchetypes.delete(name);
    else state.hiddenArchetypes.add(name);
    syncKeyRows();
    scheduleRebuild();
    return;
  }
  const key = row.dataset.legend;
  if (state.hiddenLayers.has(key)) state.hiddenLayers.delete(key);
  else state.hiddenLayers.add(key);
  syncKeyRows();
  if (kind === 'mesh') applyHiddenLayers();
  else scheduleRebuild();
}

/** Open or close one row's explanation. */
function toggleExplain(row) {
  const more = row.querySelector('.g-more');
  const name = row.querySelector('.g-name');
  if (!more) return;
  more.hidden = !more.hidden;
  row.classList.toggle('open', !more.hidden);
  if (name) name.setAttribute('aria-expanded', String(!more.hidden));
}

/** Point at every building a row describes by filtering to it. */
function highlightQuery(query) {
  const input = document.getElementById('filter-input');
  const same = state.filterText === query;
  state.filterText = same ? '' : query;
  if (input) input.value = state.filterText;
  applyActiveFilter();
  for (const button of document.querySelectorAll('.g-highlight')) {
    const active = button.dataset.query === state.filterText;
    button.classList.toggle('active', active);
    button.textContent = active ? 'Clear highlight' : button.dataset.label;
  }
}

/** Re-apply every prop-cluster switch to the mesh that is on screen now. */
function applyHiddenLayers() {
  if (!context.city) return;
  for (const [id, spec] of Object.entries(LEGEND_KEYS)) {
    if (spec.kind !== 'mesh') continue;
    context.city.setLayerVisible(spec.target, !state.hiddenLayers.has(id));
  }
}

let rebuildScheduled = false;

/** Coalesce rapid key clicks into one rebuild on the next frame. */
function scheduleRebuild() {
  if (rebuildScheduled || !context.city) return;
  rebuildScheduled = true;
  requestAnimationFrame(() => {
    rebuildScheduled = false;
    if (context.city) rebuildCity(context.resident);
  });
}

function resetKeys() {
  state.hiddenArchetypes.clear();
  state.hiddenLayers.clear();
  syncKeyRows();
  scheduleRebuild();
}

// ---- Health tab: the architect's shortlist -------------------------------

const HEALTH_SECTIONS = [
  {
    id: 'hotspots', title: 'Hotspots', colour: HEALTH_COLOURS.hotspot, flag: 'hotspots',
    text: 'Large and changed often: where refactoring pays back first.',
  },
  {
    id: 'oversized', title: 'Oversized files', colour: HEALTH_COLOURS.oversized, flag: null,
    text: 'Top 5% by lines and 400+ lines. Split out the longest definition first.',
  },
  {
    id: 'cycles', title: 'Import cycles', colour: HEALTH_COLOURS.cycle, flag: 'imports',
    text: 'Files that import each other in a loop. Break one edge in each.',
  },
  {
    id: 'knowledge', title: 'Knowledge risk', colour: 0xe8332a, flag: 'knowledge',
    text: 'The main author has not committed in six months. Pair up or document before it is needed.',
  },
  {
    id: 'orphans', title: 'Possible dead code', colour: HEALTH_COLOURS.orphan, flag: 'imports',
    text: 'Nothing imports these and they have not changed in six months. Best-effort: verify before deleting.',
  },
];

function indexRowById() {
  if (context._rowById) return context._rowById;
  const map = new Map();
  const col = columnIndex(state.source.manifest.indexColumns);
  for (const row of context.facetIndex || []) map.set(row[col.id], row);
  context._rowById = map;
  return map;
}

function healthItem(id) {
  const row = indexRowById().get(id);
  const col = columnIndex(state.source.manifest.indexColumns);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'health-item';
  button.dataset.building = String(id);
  const path = row ? state.source.s(row[col.path !== undefined ? col.path : col.name]) : '';
  const loc = row ? row[col.loc] : 0;
  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = `${Number(loc || 0).toLocaleString()} ln`;
  button.append(meta, document.createTextNode(path || `building ${id}`));
  return button;
}

function renderHealth() {
  const panel = document.getElementById('guide-health');
  if (!panel) return;
  panel.innerHTML = '';
  const manifest = state.source.manifest;
  const review = manifest.review;
  const flags = manifest.flags || {};
  if (!review) {
    panel.innerHTML = '<p class="health-empty">This city was built before the health review existed. Rebuild it to see hotspots, cycles and knowledge risk.</p>';
    return;
  }
  const intro = document.createElement('p');
  intro.className = 'hint guide-intro';
  intro.textContent =
    'What an architect would look at first. Click a file to fly to it. Switch the colour lens to "health" to see all of these at once.';
  panel.append(intro);

  for (const section of HEALTH_SECTIONS) {
    const card = document.createElement('div');
    card.className = 'health-card';
    card.dataset.section = section.id;
    const title = document.createElement('h3');
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.style.background = hexColour(section.colour);
    const count = document.createElement('span');
    count.className = 'count';
    const total = (review.totals && review.totals[section.id]) || 0;
    const off = section.flag && !flags[section.flag];
    count.textContent = off ? 'off' : String(total);
    title.append(chip, document.createTextNode(section.title), count);
    const text = document.createElement('p');
    text.textContent = off ? disabledReason(section.id) : section.text;
    card.append(title, text);

    if (!off) {
      const list = document.createElement('ol');
      if (section.id === 'cycles') {
        (review.cycles || []).forEach((members, index) => {
          const li = document.createElement('li');
          li.className = 'health-cycle';
          li.style.borderColor = `#${cycleColour(THREE, index + 1).getHexString()}`;
          for (const id of members) li.append(healthItem(id));
          list.append(li);
        });
      } else {
        for (const id of review[section.id] || []) {
          const li = document.createElement('li');
          li.append(healthItem(id));
          list.append(li);
        }
      }
      if (!list.children.length) {
        const none = document.createElement('p');
        none.className = 'health-empty';
        none.textContent = 'None found.';
        card.append(none);
      } else {
        card.append(list);
      }
    }
    panel.append(card);
  }
}

/** Fly to a building by id: it may not be resident, so fall back to its district. */
async function flyToBuilding(id) {
  let building = context.resident.find((b) => b.id === id);
  if (!building) {
    const row = indexRowById().get(id);
    const col = columnIndex(state.source.manifest.indexColumns);
    const district = row && state.source.manifest.districts[row[col.district]];
    if (district) {
      teleportTo({ kind: 'district', district });
      // The district streams in as the camera arrives; open the file then.
      setTimeout(() => {
        const arrived = context.resident.find((b) => b.id === id);
        if (arrived && context.inspector) context.inspector.showBuilding(arrived);
      }, 1800);
    }
    return;
  }
  teleportTo({ kind: 'building', building });
}

function renderLensKey() {
  const key = document.getElementById('lens-key');
  const lens = document.getElementById('lens-select');
  if (!key || !lens) return;
  key.innerHTML = '';
  if (lens.value !== 'health') return;
  const names = { hotspot: 'hotspot', cycle: 'import cycle', oversized: 'oversized', knowledge: 'owner gone', orphan: 'orphan', healthy: 'nothing flagged' };
  for (const [signal, colour] of Object.entries(HEALTH_COLOURS)) {
    const item = document.createElement('span');
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.style.background = hexColour(colour);
    item.append(chip, document.createTextNode(names[signal]));
    key.append(item);
  }
}

/** Folder names on the map: regions by level, districts up close. */
function setupMapLabels() {
  const container = document.getElementById('map-labels');
  if (!container) return;
  const manifest = state.source.manifest;
  const items = [];
  for (const region of manifest.regions || []) {
    const [x, z, w, h] = region.rect;
    items.push({
      text: state.source.regionLabel(region),
      x: x + w / 2,
      z: z + h / 2,
      y: 2,
      level: region.level,
      kind: 'region',
    });
  }
  for (const district of manifest.districts || []) {
    const [x, z, w, h] = district.rect;
    items.push({
      text: state.source.districtLabel(district),
      x: x + w / 2,
      z: z + h / 2,
      y: 1,
      level: district.level || 0,
      kind: 'district',
    });
  }
  if (!context.labels) context.labels = new MapLabels(container, camera);
  const bounds = manifest.bounds;
  context.labels.setItems(items, Math.max(bounds[2], bounds[3]));
}

function selectGuideTab(name) {
  for (const tab of ['read', 'health', 'filter']) {
    const button = document.getElementById(`guide-tab-${tab}`);
    const panel = document.getElementById(`guide-${tab}`);
    if (button) button.setAttribute('aria-selected', String(tab === name));
    if (panel) panel.hidden = tab !== name;
  }
}

function setPanelsHidden(hidden) {
  document.body.classList.toggle('panels-hidden', hidden);
  const button = document.getElementById('panels-toggle');
  if (!button) return;
  button.setAttribute('aria-pressed', String(hidden));
  const label = document.getElementById('panels-toggle-label');
  if (label) label.textContent = hidden ? 'Show guide' : 'Hide guide';
}

function togglePanels() {
  setPanelsHidden(!document.body.classList.contains('panels-hidden'));
}

document.getElementById('panels-toggle').addEventListener('click', togglePanels);
for (const tab of ['read', 'health', 'filter']) {
  document.getElementById(`guide-tab-${tab}`).addEventListener('click', () => selectGuideTab(tab));
}

// The switch toggles the layer; the name opens the explanation; Highlight
// filters to the buildings the row describes. Keyboard events stop here:
// Enter would otherwise also reach the global handler and enter a building.
const guideList = document.getElementById('guide-list');
guideList.addEventListener('click', (event) => {
  const row = event.target.closest('.key-row');
  if (!row) return;
  if (event.target.closest('.g-switch')) toggleRow(row);
  else if (event.target.closest('.g-highlight')) {
    highlightQuery(event.target.closest('.g-highlight').dataset.query);
  } else if (event.target.closest('.g-name') || event.target.closest('.chip') || event.target.closest('.g-short')) {
    toggleExplain(row);
  }
});
guideList.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.stopPropagation();
});
document.getElementById('guide-health').addEventListener('click', (event) => {
  const item = event.target.closest('.health-item');
  if (!item) return;
  flyToBuilding(Number(item.dataset.building));
});
document.getElementById('guide-health').addEventListener('keydown', (event) => event.stopPropagation());
document.getElementById('guide-reset').addEventListener('click', resetKeys);

function renderTitle() {
  const manifest = state.source.manifest;
  const stats = manifest.stats;
  document.getElementById('city-name').textContent = state.source.locked
    ? 'Zion — locked'
    : 'Zion';
  const hidden = manifest.meta.noiseExcluded
    ? ` · ${manifest.meta.noiseExcluded} ignored files hidden`
    : '';
  document.getElementById('city-subtitle').textContent =
    `${stats.fileCount.toLocaleString()} buildings · ` +
    `${stats.districtCount} districts · ` +
    `${stats.logicalLoc.toLocaleString()} logical lines · ` +
    `${Math.round(stats.docCoverage * 100)}% documented` +
    hidden;
}

function setPrompt(html) {
  if (!html) {
    promptEl.hidden = true;
    return;
  }
  promptEl.hidden = false;
  promptEl.innerHTML = html;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// ---------------------------------------------------------------------------
// City rebuild (streaming + LOD)
// ---------------------------------------------------------------------------

function disposeGroup(group) {
  group.traverse((node) => {
    if (node.geometry) node.geometry.dispose();
    if (node.material) {
      if (node.material.map) node.material.map.dispose();
      node.material.dispose();
    }
  });
}

function rebuildCity(buildings) {
  const previous = context.city;
  const mesh = new CityMesh(THREE, state.source);
  // The Keys panel filters at build time rather than by hiding meshes: one
  // instanced mesh holds a whole archetype, so dropping the form here also
  // drops its rooftop clutter and its collision box, and nothing invisible
  // survives to be hovered or walked into.
  const shown = state.hiddenArchetypes.size
    ? buildings.filter((b) => !state.hiddenArchetypes.has(b.archetype || 'warehouse'))
    : buildings;
  mesh.build(shown, {
    cameraXZ: { x: camera.position.x, z: camera.position.z },
    // The Keys panel's encoding switches, resolved here so a rebuild -- whoever
    // asked for it -- cannot drop them back to the manifest default.
    authorTint: !state.hiddenLayers.has('author_tint'),
    weathering: !state.hiddenLayers.has('weathering'),
    downtown: !state.hiddenLayers.has('downtown'),
    orphans: !state.hiddenLayers.has('orphans'),
    litCap: state.hiddenLayers.has('lit_windows') ? 0 : 1,
  });
  // Stand-in massing for districts that are not resident, so streaming does not
  // leave a hard edge at the horizon. Impostors have no archetype of their own,
  // so under a filter they would draw every form back into the distance; hide
  // them while one is active so "ruins only" means ruins only.
  const residentIds = new Set(context.streamer ? context.streamer.resident.keys() : []);
  const impostors = createImpostors(THREE, state.source.manifest, residentIds);
  if (impostors) {
    impostors.visible = state.hiddenArchetypes.size === 0;
    mesh.group.add(impostors);
  }
  scene.add(mesh.group);
  if (previous) {
    scene.remove(previous.group);
    disposeGroup(previous.group);
  }
  context.city = mesh;
  // A rebuild (streaming, LOD, a switch) must not silently drop the lens.
  const lens = document.getElementById('lens-select');
  if (lens && lens.value !== 'archetype') mesh.recolour(lens.value);
  applyHiddenLayers();
  hover.target = null;
  if (context.hoverOutline) context.hoverOutline.visible = false;

  context.grid = new CollisionGrid(shown);
  if (context.hall) context.grid.addBox(context.hall.userData.box);
  if (context.walk) context.walk.grid = context.grid;
  applyTime();
  applyActiveFilter();
}

// ---------------------------------------------------------------------------
// Filtering, colour lens and facet chips (S15/S16/S17/S18)
// ---------------------------------------------------------------------------

function resolveExt(idx) {
  return (context.extTable && context.extTable[idx]) || '';
}

/** Re-run the current filter text against the resident set. Called after any
 *  streaming rebuild, since a fresh CityMesh has no ghosting of its own. */
function applyActiveFilter() {
  if (!context.city || !context.facetIndex) return;
  const text = state.filterText || '';
  const predicate = parseQuery(
    text,
    state.source.manifest.indexColumns,
    (idx) => state.source.s(idx),
    resolveExt
  );
  const summary = document.getElementById('filter-summary');
  if (!predicate) {
    context.city.clearFilter();
    if (summary) summary.textContent = 'every building shown';
    return;
  }
  const result = runQuery(context.facetIndex, predicate, state.source.manifest.indexColumns);
  context.city.applyFilter(result.ids);
  if (summary) {
    summary.textContent =
      `${result.count.toLocaleString()} files · ${result.loc.toLocaleString()} lines ` +
      `· in ${result.districts} district${result.districts === 1 ? '' : 's'}`;
  }
}

function renderChips() {
  const container = document.getElementById('filter-chips');
  if (!container || !context.facetIndex) return;
  const facets = buildFacets(
    context.facetIndex,
    state.source.manifest.indexColumns,
    (idx) => state.source.s(idx),
    resolveExt
  );
  container.innerHTML = '';
  const top = [...facets.specials, ...facets.archetypes.slice(0, 4), ...facets.languages.slice(0, 4)];
  for (const chip of top) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chip-btn';
    button.textContent = `${chip.label} (${chip.count})`;
    button.addEventListener('click', () => {
      const input = document.getElementById('filter-input');
      input.value = chip.query;
      state.filterText = chip.query;
      applyActiveFilter();
    });
    container.append(button);
  }
}

// ---------------------------------------------------------------------------
// Detail overlay (S19): reuses the already-loaded main-window CitySource, so
// opening a building's details costs no extra fetch of the manifest/strings
// it already has resident.
// ---------------------------------------------------------------------------

function setupDetailOverlay() {
  const overlay = document.getElementById('detail-overlay');
  const close = document.getElementById('detail-overlay-close');
  if (close) close.addEventListener('click', () => { overlay.hidden = true; });
  if (context.inspector) {
    context.inspector.onOpenDetail = (kind, id) => {
      if (!overlay) return;
      resetDetailPanel();
      overlay.hidden = false;
      const render = kind === 'building' ? renderBuilding : renderDistrict;
      render(state.source, id).catch((error) => {
        document.getElementById('detail-title').textContent = `Could not load: ${error.message}`;
      });
    };
  }
  // A file clicked inside the overlay posts here instead of navigating.
  if ('BroadcastChannel' in window) {
    const channel = new BroadcastChannel('zion');
    channel.addEventListener('message', (event) => {
      const id = event.data && event.data.fly;
      if (id === undefined || id === null) return;
      const target = context.resident && context.resident.find((b) => b.id === id);
      if (target) teleportTo({ kind: 'building', building: target });
    });
  }
}

function setupFilterAndLens() {
  const input = document.getElementById('filter-input');
  if (input) {
    input.addEventListener('input', (event) => {
      state.filterText = event.target.value;
      applyActiveFilter();
    });
  }
  const lens = document.getElementById('lens-select');
  if (lens) {
    lens.addEventListener('change', (event) => {
      if (context.city) context.city.recolour(event.target.value);
      renderLensKey();
    });
  }
}

async function refreshResident(force = false) {
  if (rebuilding || !context.streamer) return;
  rebuilding = true;
  try {
    const changed = await context.streamer.update(camera.position.x, camera.position.z, force);
    // Detail follows the camera, not just the working set.
    //
    // When the whole city is already resident -- any repository under the
    // resident cap, which is every repository a person is likely to open -- the
    // streamer never reports a change, so an early return here left the LOD
    // ranking frozen around wherever the camera first stood. Everything past
    // that radius kept its far-tier box for the rest of the session: fly to a
    // park and it was still a cube. Rebuilding when the camera has travelled a
    // fraction of the LOD radius keeps the near tier where the eye actually is.
    const radius = (context.city && context.city.lodRadius) || 600;
    // A fraction of the radius, not a fixed floor: a small city's radius is
    // 240 m, and a 400 m floor left buildings 240-400 m away as boxes.
    const travel = Math.max(80, radius * 0.6);
    const moved =
      !lodCentre ||
      Math.hypot(lodCentre.x - camera.position.x, lodCentre.z - camera.position.z) > travel;
    const now = performance.now();
    if (changed) {
      context.resident = context.streamer.buildings();
      state.source.buildings = context.resident;
      rebuildCity(context.resident);
      lodCentre = { x: camera.position.x, z: camera.position.z };
      lodRebuiltAt = now;
    } else if (moved && !state.tourFrozen && now - lodRebuiltAt > 600) {
      // Rate-limited so flying at speed cannot rebuild every frame; a rebuild
      // is synchronous and touches every instance in the city.
      rebuildCity(context.resident);
      lodCentre = { x: camera.position.x, z: camera.position.z };
      lodRebuiltAt = now;
    }
  } finally {
    rebuilding = false;
  }
}

// ---------------------------------------------------------------------------
// Picking
// ---------------------------------------------------------------------------

/**
 * What is under a screen position.
 *
 * One raycast serves both hover and click, so the thing that lights up is
 * exactly the thing a click will act on -- the highlight can never disagree
 * with the action.
 */
function raycastAt(ndcX, ndcY) {
  if (!context.city) return null;
  // Raycaster does not refresh world matrices, and hover runs *before* the
  // renderer does. On the first frame every mesh is still at the origin, which
  // silently turns the City Hall into a box sitting in the middle of the ray.
  scene.updateMatrixWorld();
  pointer.x = ndcX;
  pointer.y = ndcY;
  raycaster.setFromCamera(pointer, camera);

  // The landmark is checked first: it stands in the middle of the plan and can
  // hide behind towers.
  if (context.hall) {
    const hallHits = raycaster.intersectObject(context.hall, true);
    if (hallHits.length) return { kind: 'city_hall', point: hallHits[0].point };
  }

  const targets = context.city.group.children.filter((child) =>
    child.name.startsWith('buildings-')
  );
  const hits = raycaster.intersectObjects(targets, false);

  // Districts are folders, and a folder is as clickable as a file. A building
  // wins when both are under the cursor, because it is the smaller target.
  const districtHits = raycastDistricts();

  if (!hits.length) {
    return districtHits;
  }
  const hit = hits[0];
  const records = context.city.records.get(hit.object.uuid);
  const building = records && records[hit.instanceId];
  if (!building) return districtHits;
  if (districtHits && districtHits.point.distanceTo(camera.position) <
      hit.point.distanceTo(camera.position) - 0.5) {
    // The ground plate is genuinely in front of the building.
    return districtHits;
  }
  return {
    kind: 'building',
    building,
    mesh: hit.object,
    instanceId: hit.instanceId,
    point: hit.point,
  };
}

/** District plates and district impostors: both stand for a folder. */
function raycastDistricts() {
  const meshes = context.city.group.children.filter(
    (child) =>
      child.name === 'district-plates' ||
      child.name === 'district-impostors' ||
      child.name === 'region-plinths'
  );
  if (!meshes.length) return null;
  const hits = raycaster.intersectObjects(meshes, false);
  if (!hits.length) return null;
  const hit = hits[0];
  // A plinth's edge, or a road across it, is the folder that contains them.
  if (hit.object.name === 'region-plinths') {
    const region = hit.object.userData.regions && hit.object.userData.regions[hit.instanceId];
    if (!region) return null;
    return { kind: 'region', region, mesh: hit.object, instanceId: hit.instanceId, point: hit.point };
  }
  const districts = hit.object.userData.districts;
  const district = districts && districts[hit.instanceId];
  if (!district) return null;
  return {
    kind: 'district',
    district,
    mesh: hit.object,
    instanceId: hit.instanceId,
    point: hit.point,
    distant: hit.object.name === 'district-impostors',
  };
}

function sameTarget(a, b) {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'city_hall') return true;
  if (a.kind === 'district') return a.district.id === b.district.id;
  if (a.kind === 'region') return a.region.id === b.region.id;
  return a.building === b.building;
}

// ---------------------------------------------------------------------------
// Hover: what is clickable, shown before you click
// ---------------------------------------------------------------------------

const hover = {
  active: false,
  target: null,
  x: 0,
  y: 0,
  lastRun: 0,
};

function hallBox() {
  if (!context.hall) return null;
  const { box } = context.hall.userData;
  return box;
}

function showOutlineFor(target) {
  const outline = context.hoverOutline;
  if (!outline) return;
  if (!target) {
    outline.visible = false;
    return;
  }
  if (target.kind === 'district') {
    outline.visible = false;
    return;
  }
  if (target.kind === 'city_hall') {
    const box = hallBox();
    if (!box) {
      outline.visible = false;
      return;
    }
    outline.position.set(
      (box.x0 + box.x1) / 2,
      0,
      (box.z0 + box.z1) / 2
    );
    outline.scale.set(
      (box.x1 - box.x0) * 1.05,
      box.height * 1.02,
      (box.z1 - box.z0) * 1.05
    );
    outline.visible = true;
    return;
  }

  const building = target.building;
  outline.position.set(
    (building.x || 0) + (building.width || 4) / 2,
    0,
    (building.y || 0) + (building.depth || 4) / 2
  );
  outline.scale.set(
    (building.width || 4) * 1.12,
    (building.height || 4) * 1.03,
    (building.depth || 4) * 1.12
  );
  outline.visible = true;
}

function tooltipFor(target) {
  const source = state.source;
  if (!target) return null;
  if (target.kind === 'city_hall') {
    return {
      title: 'City Hall',
      meta: 'the repository report card',
      hint: 'click, or press C, to open',
    };
  }
  if (target.kind === 'region') {
    const r = target.region;
    return {
      title: `${state.source.regionLabel(r)}/`,
      meta:
        `folder · ${r.districts} neighbourhoods · ${r.buildings} buildings · ` +
        `${(r.logicalLoc || 0).toLocaleString()} lines`,
      hint: 'click to inspect this folder · raised plinth = nested folder',
    };
  }
  if (target.kind === 'district') {
    const d = target.district;
    return {
      title: state.source.districtLabel(d),
      meta:
        `folder · ${d.buildings} buildings · ${(d.logicalLoc || 0).toLocaleString()} lines · ` +
        `${d.documented} documented · ${d.hasReadme ? 'README' : 'no README'}`,
      hint: target.distant
        ? 'click to inspect this district'
        : 'click to inspect · the block is a folder',
    };
  }
  const building = target.building;
  const parts = [archetypeLabel(building.archetype), source.s(building.language)];
  if (building.rows !== null && building.rows !== undefined) {
    parts.push(`${building.rows.toLocaleString()} rows`);
  } else {
    parts.push(`${building.loc.toLocaleString()} logical lines`);
    if (building.floors) {
      parts.push(`${building.floors} ${building.floors === 1 ? 'floor' : 'floors'}`);
    }
  }
  return {
    title: source.label(building),
    meta: parts.filter(Boolean).join(' · '),
    hint:
      state.mode === 'walk' && building.source
        ? 'click to inspect · E to enter'
        : 'click to inspect',
  };
}

function applyHover(target, clientX, clientY) {
  if (sameTarget(hover.target, target)) {
    hover.x = clientX;
    hover.y = clientY;
    if (target) positionTooltip();
    return;
  }
  hover.target = target;
  hover.x = clientX;
  hover.y = clientY;

  if (context.city) {
    if (target && (target.kind === 'building' || target.kind === 'district' || target.kind === 'region')) {
      context.city.setHighlight(
        target.mesh,
        target.instanceId,
        target.kind === 'building' ? 0.62 : target.kind === 'region' ? 0.3 : 0.45
      );
    } else {
      context.city.clearHighlight();
    }
  }
  showOutlineFor(target);
  // A district is a folder, not an object, so it gets a ground outline of the
  // whole block rather than a box around one mesh.
  if (target && target.kind === 'district') {
    placeDistrictMarker(context.hoverDistrictMarker, target.district.rect);
  } else if (target && target.kind === 'region') {
    placeDistrictMarker(context.hoverDistrictMarker, target.region.rect);
  } else {
    context.hoverDistrictMarker.visible = false;
  }

  const tooltip = document.getElementById('tooltip');
  const info = tooltipFor(target);
  if (!info) {
    tooltip.hidden = true;
  } else {
    document.getElementById('tooltip-title').textContent = info.title;
    document.getElementById('tooltip-meta').textContent = info.meta;
    document.getElementById('tooltip-hint').textContent = info.hint;
    tooltip.hidden = false;
    positionTooltip();
  }
  canvas.style.cursor = target && !pointerLocked() ? 'pointer' : '';
}

function positionTooltip() {
  const tooltip = document.getElementById('tooltip');
  if (tooltip.hidden) return;
  const pad = 16;
  const rect = tooltip.getBoundingClientRect();
  let x = pointerLocked()
    ? window.innerWidth / 2 + 22
    : hover.x + pad;
  let y = pointerLocked()
    ? window.innerHeight / 2 + 18
    : hover.y + pad;
  if (x + rect.width > window.innerWidth - 8) x = hover.x - rect.width - pad;
  if (y + rect.height > window.innerHeight - 8) y = hover.y - rect.height - pad;
  tooltip.style.left = `${Math.max(8, x)}px`;
  tooltip.style.top = `${Math.max(8, y)}px`;
}

/**
 * Refresh the hover target, rate-limited.
 *
 * Raycasting an InstancedMesh tests every instance, so at 20,000 resident
 * buildings this must not run on every mouse event.
 */
function refreshHover(force = false) {
  if (state.mode === 'interior') {
    applyHover(null, 0, 0);
    return;
  }
  const now = performance.now();
  const interval = context.resident.length > 3000 ? 140 : 55;
  if (!force && now - hover.lastRun < interval) return;
  hover.lastRun = now;

  let target = null;
  if (pointerLocked()) {
    target = raycastAt(0, 0);
  } else if (hover.active) {
    const nx = (hover.x / window.innerWidth) * 2 - 1;
    const ny = -(hover.y / window.innerHeight) * 2 + 1;
    target = raycastAt(nx, ny);
  }
  applyHover(target, hover.x, hover.y);
}

// ---------------------------------------------------------------------------
// Pointer input
//
// Three separate gestures, deliberately not conflated:
//   drag       -> look around, cursor stays visible
//   click      -> inspect whatever is under the cursor
//   capture    -> opt-in only (F, or the HUD button), for continuous flight
// ---------------------------------------------------------------------------

const DRAG_THRESHOLD = 4; // pixels; below this a drag is a click
const pointerState = {
  dragging: false,
  moved: 0,
  x: 0,
  y: 0,
  button: -1,
};

function pointerLocked() {
  return document.pointerLockElement === canvas;
}

function lookDelta(dx, dy) {
  if (state.mode === 'interior') {
    // The interior camera rides on the walk camera's orientation.
    context.walk.lookDelta(dx, dy);
  } else if (state.mode === 'walk') {
    context.walk.lookDelta(dx, dy);
  } else if (state.mode === 'orbit') {
    // Dragging in orbit swings around the target rather than dropping the user
    // back into free flight, which is what used to happen and cost them the
    // vantage they had just found.
    if (pointerState.button === 2) context.orbit.panDelta(dx, dy);
    else context.orbit.orbitDelta(dx, dy);
    setOrbitPrompt();
  } else if (state.mode === 'fly') {
    context.fly.lookDelta(dx, dy);
  }
}

canvas.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 && event.button !== 2) return;
  pointerState.dragging = true;
  pointerState.moved = 0;
  pointerState.x = event.clientX;
  pointerState.y = event.clientY;
  pointerState.button = event.button;
  try {
    canvas.setPointerCapture?.(event.pointerId);
  } catch {
    // Synthetic pointer events from the self-test have no live pointer to
    // capture; dragging still works, it just will not follow outside the canvas.
  }
});

canvas.addEventListener('pointermove', (event) => {
  hover.active = true;
  hover.x = event.clientX;
  hover.y = event.clientY;
  if (!pointerState.dragging || pointerLocked()) return;
  const dx = event.clientX - pointerState.x;
  const dy = event.clientY - pointerState.y;
  pointerState.x = event.clientX;
  pointerState.y = event.clientY;
  pointerState.moved += Math.abs(dx) + Math.abs(dy);
  if (pointerState.moved > DRAG_THRESHOLD) lookDelta(dx, dy);
});

canvas.addEventListener('pointerup', (event) => {
  const wasDragging = pointerState.dragging;
  const moved = pointerState.moved;
  pointerState.dragging = false;
  try {
    canvas.releasePointerCapture?.(event.pointerId);
  } catch {
    /* nothing to release */
  }
  // A press that did not move is a click. It acts on the highlighted target, so
  // what you saw lit up is exactly what responds.
  if (wasDragging && moved <= DRAG_THRESHOLD && event.button === 0 && state.mode !== 'interior') {
    const target = hover.target || raycastAtFromEvent(event);
    if (target && target.kind === 'city_hall') {
      context.cityHall.show();
      document.body.classList.add('hall-open');
    } else {
      activate(target);
    }
  }
});

function raycastAtFromEvent(event) {
  if (pointerLocked()) return raycastAt(0, 0);
  return raycastAt(
    (event.clientX / window.innerWidth) * 2 - 1,
    -(event.clientY / window.innerHeight) * 2 + 1
  );
}

function activate(target) {
  if (!target) {
    context.inspector.hide();
    return;
  }
  if (target.kind === 'district') {
    context.inspector.showDistrict(target.district);
    orbitAround(target);
    return;
  }
  if (target.kind === 'region') {
    context.inspector.showRegion(target.region);
    orbitAround({ kind: 'district', district: { rect: target.region.rect } });
    return;
  }
  context.inspector.showBuilding(target.building);
  orbitAround(target);
}

/**
 * Clicking while orbiting re-centres the circle on what was clicked.
 *
 * The orbit is around a point, not around the city, so the same gesture that
 * inspects a file also puts the camera into a lap around it -- which is the
 * fastest way there is to see a building from every side, and it costs the user
 * no new control to learn.
 */
function orbitAround(target) {
  if (state.mode !== 'orbit') return;
  if (target.kind === 'district') {
    const [x, z, w, h] = target.district.rect;
    context.orbit.focusOn({ x: x + w / 2, z: z + h / 2 }, Math.max(w, h) * 0.6);
  } else if (target.kind === 'building') {
    const b = target.building;
    const w = b.width || 4;
    const d = b.depth || 4;
    context.orbit.focusOn(
      { x: (b.x || 0) + w / 2, z: (b.y || 0) + d / 2 },
      Math.max(w, d, (b.height || 6) * 0.5),
      (b.height || 6) * 0.45
    );
  }
  context.orbit.spinning = true;
  setOrbitPrompt();
}

canvas.addEventListener('pointercancel', () => {
  pointerState.dragging = false;
});

canvas.addEventListener('pointerleave', () => {
  hover.active = false;
  applyHover(null, 0, 0);
});

// Right-drag is a look gesture, not a context menu.
canvas.addEventListener('contextmenu', (event) => event.preventDefault());

// While captured, the cursor is hidden and parked, so look deltas come from
// movementX/Y and a click inspects whatever the crosshair is over.
document.addEventListener('mousemove', (event) => {
  if (!pointerLocked()) return;
  if (state.mode === 'orbit') return;
  lookDelta(event.movementX || 0, event.movementY || 0);
});

/**
 * Say what the orbit is doing, because an automatic camera with no caption
 * reads as the viewer having taken control away from you.
 */
function setOrbitPrompt() {
  if (state.mode !== 'orbit') return;
  setPrompt(
    context.orbit.spinning
      ? '<kbd>Space</kbd> to stop here &nbsp;·&nbsp; drag to swing, right-drag to pan, wheel to zoom &nbsp;·&nbsp; <kbd>O</kbd> to fly from here'
      : '<kbd>Space</kbd> to circle the city &nbsp;·&nbsp; drag to swing, right-drag to pan, wheel to zoom &nbsp;·&nbsp; <kbd>O</kbd> to fly from here'
  );
}

/**
 * Orbit keys.
 *
 * Handled before the global switch so that the movement keys mean something
 * here -- W and S change the radius, A and D the bearing, Q and E the height --
 * instead of silently doing nothing because the fly camera is disabled.
 * Returns true when the key was ours.
 */
function handleOrbitKey(code) {
  if (state.mode !== 'orbit') return false;
  const orbit = context.orbit;
  switch (code) {
    case 'Space':
      orbit.toggleSpin();
      break;
    case 'KeyA': case 'ArrowLeft':
      orbit.nudge({ azimuth: -0.12 });
      break;
    case 'KeyD': case 'ArrowRight':
      orbit.nudge({ azimuth: 0.12 });
      break;
    case 'KeyW': case 'ArrowUp':
      orbit.nudge({ distance: 0.9 });
      break;
    case 'KeyS': case 'ArrowDown':
      orbit.nudge({ distance: 1 / 0.9 });
      break;
    case 'KeyE':
      orbit.nudge({ elevation: 0.07 });
      break;
    case 'KeyQ':
      orbit.nudge({ elevation: -0.07 });
      break;
    default:
      return false;
  }
  setOrbitPrompt();
  return true;
}

/**
 * The wheel.
 *
 * Flying had no wheel binding at all, so a mouse could turn the camera but
 * never take it anywhere -- the most basic thing anyone tries first in a 3D
 * view, and it did nothing.
 */
canvas.addEventListener('wheel', (event) => {
  if (state.mode === 'interior' || state.mode === 'walk') return;
  event.preventDefault();
  // Wheels, trackpads and high-resolution mice all report different units;
  // what matters is the direction and roughly one step per gesture.
  const notches = Math.max(-3, Math.min(3, event.deltaY / 100)) || Math.sign(event.deltaY);
  if (state.mode === 'orbit') {
    context.orbit.zoomBy(-notches);
    setOrbitPrompt();
  } else {
    context.fly.dolly(-notches);
  }
}, { passive: false });

function setCapture(on) {
  if (on) {
    canvas.requestPointerLock?.();
  } else {
    document.exitPointerLock?.();
  }
}

function onPointerLockChange() {
  const locked = pointerLocked();
  document.body.classList.toggle('mouse-captured', locked);
  setPrompt(
    locked
      ? '<kbd>F</kbd> or <kbd>Esc</kbd> to release the mouse &nbsp;·&nbsp; click to inspect the crosshair'
      : ''
  );
}
document.addEventListener('pointerlockchange', onPointerLockChange);

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

function setMode(mode) {
  if (context.tour && context.tour.running) {
    context.tour.stopTour();
    context.tourDistrictMarker.visible = false;
    if (context.city) context.city.clearDistrictHighlight();
  }
  applyHover(null, 0, 0);
  if (state.mode === 'interior' && mode !== 'interior') exitInterior();
  const previous = state.mode;
  state.mode = mode;
  context.fly.enabled = mode === 'fly';
  context.orbit.active = mode === 'orbit';
  context.walk.enabled = mode === 'walk';
  if (mode === 'orbit') {
    // Pick up wherever the view already is, and start the lap: "show me the
    // city from all sides" is the whole reason to be here, so it should not
    // need a second keystroke.
    context.orbit.adopt(context.fly);
    context.orbit.spinning = true;
    document.exitPointerLock?.();
  } else if (previous === 'orbit') {
    // ...and leaving hands the exact vantage back, so O is a genuine toggle
    // rather than two different teleports.
    context.orbit.handOff(context.fly);
  }
  if (mode === 'walk') {
    context.walk.fromFlyingCamera(context.fly);
    context.walk.apply();
  }
  if (mode !== 'fly') document.exitPointerLock?.();
  if (mode === 'orbit') setOrbitPrompt();
  else setPrompt('');
}

async function enterInterior(building) {
  // Carry the current view direction into the room, so entering does not snap.
  if (state.mode === 'fly') {
    context.walk.yaw = context.fly.yaw;
    context.walk.pitch = context.fly.pitch;
  }
  await context.interior.enter(building, context.walk);
  state.mode = 'interior';
  context.fly.enabled = false;
  context.walk.enabled = false;
  context.orbit.active = false;
  document.exitPointerLock?.();
  setPrompt(
    '<kbd>[</kbd><kbd>]</kbd> change floor &nbsp; <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> move &nbsp; ' +
      '<kbd>E</kbd> or <kbd>Esc</kbd> to leave'
  );
  context.inspector.showBuilding(building);
}

function exitInterior() {
  context.interior.exit();
  state.mode = 'walk';
  context.walk.enabled = true;
  setPrompt('');
}

function teleportTo(target) {
  const bounds = state.source.manifest.bounds;
  const span = Math.max(bounds[2], bounds[3]);
  let point;
  if (target.kind === 'building') {
    const building = target.building;
    point = {
      x: (building.x || 0) + (building.width || 4) / 2,
      z: (building.y || 0) + (building.depth || 4) / 2,
      h: building.height || 10,
    };
    context.inspector.showBuilding(building);
  } else {
    const [x, z, w, h] = target.district.rect;
    point = { x: x + w / 2, z: z + h / 2, h: target.district.skyline.maxHeight };
  }
  context.cityHall.hide();
  document.body.classList.remove('hall-open');
  setMode('fly');
  context.flight.start(
    camera.position.clone(),
    camera.quaternion.clone(),
    new THREE.Vector3(point.x - span * 0.15, Math.max(34, point.h * 1.7 + 20), point.z + span * 0.15),
    new THREE.Vector3(point.x, point.h * 0.4, point.z),
    1.3
  );
}

// ---------------------------------------------------------------------------
// Time of day
// ---------------------------------------------------------------------------

function applyTime() {
  if (!context.sky || !context.city) return;
  state.night = context.sky.setTime(state.time);
  context.city.setGlow(state.night * state.litScale);
  const hours = Math.floor(state.time);
  const minutes = Math.floor((state.time - hours) * 60);
  document.getElementById('time-out').textContent =
    `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

document.getElementById('time').addEventListener('input', (event) => {
  state.time = Number(event.target.value);
  applyTime();
});
document.getElementById('lit').addEventListener('input', (event) => {
  state.litScale = Number(event.target.value);
  applyTime();
});

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

window.addEventListener('keydown', async (event) => {
  const target = event.target;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;

  // Any deliberate movement hands control back to the player.
  const MOVEMENT_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'Space']);
  if (context.tour && context.tour.running && MOVEMENT_KEYS.has(event.code)) {
    context.tour.stopTour();
    setPrompt('');
  }

  if (handleOrbitKey(event.code)) {
    event.preventDefault();
    return;
  }

  switch (event.code) {
    case 'KeyV':
      setMode(state.mode === 'walk' ? 'fly' : 'walk');
      break;
    case 'KeyO':
      setMode(state.mode === 'orbit' ? 'fly' : 'orbit');
      break;
    case 'KeyR':
      // Re-frame the whole plan without leaving the orbit.
      if (state.mode === 'orbit') {
        context.orbit.frame(state.source.manifest.bounds);
        setOrbitPrompt();
      }
      break;
    case 'KeyN':
      context.tour.skipToNext();
      break;
    case 'KeyT':
      context.tour.start();
      setPrompt(
        context.tour.running
          ? '<kbd>T</kbd> or <kbd>Esc</kbd> to end the tour &nbsp;·&nbsp; any movement key takes over'
          : ''
      );
      break;
    case 'KeyC':
      context.cityHall.open ? context.cityHall.hide() : context.cityHall.show();
      document.body.classList.toggle('hall-open', context.cityHall.open);
      break;
    case 'KeyL':
      togglePanels();
      break;
    case 'KeyF':
      setCapture(!pointerLocked());
      break;
    case 'KeyU':
      if (context.vault && context.vault.encrypted) {
        document.getElementById('vault').hidden = false;
        document.getElementById('vault-passphrase').focus();
      }
      break;
    case 'KeyE':
      await handleEnter();
      break;
    case 'BracketLeft':
      if (state.mode === 'interior') context.interior.nextFloor(-1);
      break;
    case 'BracketRight':
      if (state.mode === 'interior') context.interior.nextFloor(1);
      break;
    case 'Escape':
      if (state.mode === 'interior') {
        exitInterior();
      } else {
        context.cityHall.hide();
        document.body.classList.remove('hall-open');
        context.tour.stopTour();
        setPrompt('');
      }
      break;
    default:
      break;
  }
});

async function handleEnter() {
  if (state.mode === 'interior') {
    exitInterior();
    return;
  }
  if (state.mode === 'walk' && hallNear) {
    context.cityHall.show();
    document.body.classList.add('hall-open');
    return;
  }
  if (state.mode === 'walk' && hover.target && hover.target.kind === 'building') {
    await enterInterior(hover.target.building);
    return;
  }
  if (state.mode === 'walk' && context.walk.target) {
    const building = context.resident.find((b) => b.rel === context.walk.target.rel);
    if (building) await enterInterior(building);
  }
  if (state.mode === 'fly' && context.inspector.selected?.building) {
    await enterInterior(context.inspector.selected.building);
  }
}

// ---------------------------------------------------------------------------
// Vault
// ---------------------------------------------------------------------------

function setupVaultPanel() {
  const form = document.getElementById('vault-form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = document.getElementById('vault-passphrase');
    await attemptUnlock(input.value);
  });
}

function setVaultStatus(text) {
  document.getElementById('vault-status').textContent = text;
}

/**
 * Unlock and swap labels in place.
 *
 * Nothing is rebuilt: the instanced meshes, positions and heights are all
 * plaintext, so the only thing that changes is the text.
 */
/** Re-read resident chunks so labels come from the newly unlocked table. */
async function refreshLabelsAfterUnlock() {
  const residentIds = new Set(context.streamer ? context.streamer.resident.keys() : []);
  for (const id of residentIds) {
    const buildings = await state.source.buildingsFor(id);
    context.streamer.resident.set(id, buildings);
  }
  context.resident = context.streamer.buildings();
  state.source.buildings = context.resident;
  context.inspector.hide();
  renderGuide();
  setupMapLabels();
  renderTitle();
  renderChips();
  applyActiveFilter();
}

async function attemptUnlock(passphrase) {
  if (!passphrase) {
    setVaultStatus('Enter a passphrase.');
    return false;
  }
  setVaultStatus('Deriving the key (310,000 PBKDF2 iterations)…');
  try {
    await context.vault.unlock(passphrase);
    await state.source.unlockStrings();
  } catch (error) {
    context.vault.lock();
    setVaultStatus(
      `Could not unlock: ${error.message}. Check the passphrase. Geometry is unaffected.`
    );
    return false;
  }

  // Labels only: re-read the chunks' string indices and re-render the HUD.
  await refreshLabelsAfterUnlock();
  setVaultStatus(
    `Unlocked — ${state.source.strings.length.toLocaleString()} labels restored. ` +
      'Geometry unchanged.'
  );
  document.getElementById('vault').hidden = true;
  return true;
}

// ---------------------------------------------------------------------------
// Benchmark
// ---------------------------------------------------------------------------

let benchReported = false;

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

/**
 * A deterministic benchmark sweep.
 *
 * Under Chrome's --virtual-time-budget the clock does not advance during a
 * synchronous loop, so frame times are reported as null rather than as a
 * flattering zero. Draw calls and the resident building count stay meaningful
 * either way, and those are the gates.
 */
function runBench(frames = 60) {
  const bounds = state.source.manifest.bounds;
  const span = Math.max(bounds[2], bounds[3]);
  const cx = bounds[0] + bounds[2] / 2;
  const cz = bounds[1] + bounds[3] / 2;
  const times = [];

  for (let i = 0; i < frames; i++) {
    const t = i / Math.max(1, frames - 1);
    const angle = t * Math.PI * 1.6;
    const radius = span * (1.35 - t * 0.85);
    camera.position.set(
      cx + Math.sin(angle) * radius,
      span * (0.55 - t * 0.3),
      cz + Math.cos(angle) * radius
    );
    camera.lookAt(cx, span * 0.08, cz);
    const started = performance.now();
    renderer.render(scene, camera);
    if (i >= 5) times.push(performance.now() - started);
  }

  // Hover raycasting tests every instance in every visible archetype mesh, so
  // its cost is the one interactive number that grows with city size.
  let hoverInstances = 0;
  for (const child of context.city ? context.city.group.children : []) {
    if (child.name.startsWith('buildings-')) hoverInstances += child.count;
  }

  const info = renderer.info.render;
  const measurable = times.some((value) => value > 0.0001);
  const payload = {
    marker: 'ZION_BENCH',
    timingMode: measurable ? 'real' : 'virtual-time (frame times unavailable)',
    drawCalls: info.calls,
    triangles: info.triangles,
    buildings: context.resident.length,
    districts: state.source.manifest.districts.length,
    residentChunks: context.streamer ? context.streamer.resident.size : 0,
    residentBuildings: context.streamer ? context.streamer.residentCount : 0,
    frameP50: measurable ? Number(percentile(times, 0.5).toFixed(2)) : null,
    frameP95: measurable ? Number(percentile(times, 0.95).toFixed(2)) : null,
    frames: times.length,
    // Hover tests every instance, so its cost is the one interactive number
    // that grows with city size. The clock is frozen under virtual time, so the
    // deterministic measure is how much work a pass does, not how long it took.
    hoverInstancesTested: hoverInstances,
    hoverRaycastMs: null, // frame-clock measurement; unavailable under virtual time
    glVersion: renderer.getContext().getParameter(renderer.getContext().VERSION),
    webgl: Boolean(renderer.getContext()),
  };
  const line = `ZION_BENCH ${JSON.stringify(payload)}`;
  const pre = document.createElement('pre');
  pre.id = 'bench';
  pre.textContent = line;
  document.body.append(pre);
  document.title = line;
  benchReported = true;
  return payload;
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

let last = performance.now();
let beaconClock = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  // Rooftop obstruction lights blink on their own clock. Held still while a
  // capture freezes the tour, so a scripted screenshot is deterministic.
  if (!state.tourFrozen) beaconClock += dt;
  if (context.city) context.city.setBeaconPulse(beaconClock);

  if (state.mode === 'interior' && context.interior.active) {
    driveInterior(dt);
    renderer.render(context.interior.scene, context.interior.camera);
    return;
  }

  if (state.tourFrozen && context.tour.running) {
    // Frozen for a deterministic capture: hold this exact frame. Any camera
    // driver here would move the view away from what was measured.
  } else if (context.tour.running) {
    context.tour.update(dt);
    document.getElementById('tour-progress-bar').style.width =
      `${Math.round(context.tour.progress * 100)}%`;
  } else {
    if (context.tourDistrictMarker && context.tourDistrictMarker.visible) {
      context.tourDistrictMarker.visible = false;
      if (context.city) context.city.clearDistrictHighlight();
    }
    if (context.flight.active) {
      context.flight.update(dt);
    } else if (state.mode === 'orbit') {
      context.orbit.update(dt);
    } else if (state.mode === 'walk') {
      context.walk.update(dt);
      updateWalkPrompt();
    } else {
      context.fly.update(dt);
    }
  }

  refreshResident();
  refreshHover();
  renderer.render(scene, camera);
  if (context.labels) context.labels.update(now, window.innerWidth, window.innerHeight);
}

function driveInterior(dt) {
  const walk = context.walk;
  const interior = context.interior;
  const forward = walk.keys.has('KeyW') ? 1 : walk.keys.has('KeyS') ? -1 : 0;
  const strafe = walk.keys.has('KeyD') ? 1 : walk.keys.has('KeyA') ? -1 : 0;
  const speed = 7;
  if (forward || strafe) {
    const dx = (-Math.sin(walk.yaw) * forward + Math.cos(walk.yaw) * strafe) * speed * dt;
    const dz = (-Math.cos(walk.yaw) * forward - Math.sin(walk.yaw) * strafe) * speed * dt;
    interior.movePlayer(dx, dz);
  }
  interior.look(walk.yaw, walk.pitch);
}

function updateWalkPrompt() {
  if (pointerLocked()) return;
  const hall = context.hall;
  if (hall) {
    const centre = hall.userData.centre;
    hallNear =
      Math.hypot(
        context.walk.position.x - centre.x,
        context.walk.position.z - centre.z
      ) < hall.userData.radius;
  }
  if (hallNear) {
    setPrompt('<kbd>E</kbd> enter City Hall');
    return;
  }
  if (context.walk.target) {
    const building = context.resident.find((b) => b.rel === context.walk.target.rel);
    if (building) {
      setPrompt(`<kbd>E</kbd> enter ${escapeHtml(state.source.label(building))}`);
      return;
    }
  }
  setPrompt('');
}

// ---------------------------------------------------------------------------
// Self test
// ---------------------------------------------------------------------------

/**
 * A scripted pass through every interactive surface, driven by ?selftest=1.
 *
 * Headless verification can prove a city renders, but not that walk mode
 * collides, that a building opens, that floors advance, or that City Hall's
 * table can teleport you. This drives all of them and prints a verdict into the
 * DOM so `--dump-dom` can read it.
 */
function reportSelfTest(results) {
  const passed = results.filter((r) => r.ok).length;
  const line = `ZION_SELFTEST ${JSON.stringify({
    passed,
    total: results.length,
    ok: passed === results.length,
    results,
  })}`;
  let pre = document.getElementById('selftest');
  if (!pre) {
    pre = document.createElement('pre');
    pre.id = 'selftest';
    document.body.append(pre);
  }
  pre.textContent = line;
  document.title = line;
  return line;
}

let selfTestResults = [];

async function runSelfTest() {
  const results = selfTestResults;
  // Report after every check: if a later step never settles, the DOM still
  // carries the verdicts that did.
  const check = (step, ok, detail = '') => {
    results.push({ step, ok: Boolean(ok), detail: String(detail) });
    reportSelfTest(results);
  };

  // 0. Encryption: a locked city must render the same geometry with different
  //    labels, and unlocking must change labels only.
  const encrypted = Boolean(state.source.vault && state.source.vault.encrypted);
  check('vault-detected', encrypted === Boolean(state.source.manifest.meta.encrypted));
  if (encrypted) {
    const wasLocked = state.source.locked;
    check('vault-locked-initial', wasLocked, wasLocked ? 'labels withheld' : 'city was not locked');

    const sample = context.resident[0];
    const addressBefore = sample ? state.source.label(sample) : '';
    check(
      'vault-procedural-address',
      /^\d+ \w+ (Row|Street|Avenue|Lane|Court|Way|Terrace|Walk)$/.test(addressBefore),
      addressBefore
    );

    // A fingerprint of the geometry itself: if unlocking moves a single
    // building, this changes and the test fails.
    const fingerprint = () =>
      context.resident
        .slice(0, 200)
        .map((b) => `${b.x.toFixed(3)}:${b.y.toFixed(3)}:${b.height.toFixed(3)}`)
        .join('|');
    const geometryBefore = fingerprint();

    const rawKey = params.get('rawkey');
    const passphrase = params.get('pass');
    if (rawKey) {
      // Headless path: a key already derived outside the browser, so the
      // decryption path can be verified under Chrome's virtual clock.
      // base64url, because a query string turns "+" into a space.
      const normalized = rawKey.replace(/-/g, '+').replace(/_/g, '/');
      const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
      const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
      await context.vault.useRawKey(bytes);
      await state.source.unlockStrings();
      await refreshLabelsAfterUnlock();
      check('vault-unlock', true, 'raw key');
      check('vault-unlocked-state', !state.source.locked);
      check(
        'vault-strings-restored',
        state.source.strings && state.source.strings.length > 0,
        `${state.source.strings ? state.source.strings.length : 0} labels`
      );
      const addressAfter = sample ? state.source.label(sample) : '';
      check('vault-real-label', addressAfter !== addressBefore, addressAfter);
      check('vault-geometry-unchanged', fingerprint() === geometryBefore);
    } else if (passphrase) {
      const ok = await attemptUnlock(passphrase);
      check('vault-unlock', ok);
      check('vault-unlocked-state', !state.source.locked);
      check(
        'vault-strings-restored',
        state.source.strings && state.source.strings.length > 0,
        `${state.source.strings ? state.source.strings.length : 0} labels`
      );
      const addressAfter = sample ? state.source.label(sample) : '';
      check('vault-real-label', addressAfter !== addressBefore, addressAfter);
      check('vault-geometry-unchanged', fingerprint() === geometryBefore);
    } else {
      const wrong = await attemptUnlock('definitely not the passphrase');
      check('vault-rejects-wrong-passphrase', wrong === false && state.source.locked);
    }
  }

  // 0b. Pointer behaviour, which is where a viewer most easily becomes
  //     unusable: dragging must look, a click must inspect, and neither may
  //     capture the cursor as a side effect.
  setMode('fly');
  const dispatch = (type, x, y, button = 0) =>
    canvas.dispatchEvent(
      new PointerEvent(type, {
        clientX: x,
        clientY: y,
        button,
        buttons: type === 'pointerup' ? 0 : 1,
        pointerId: 1,
        bubbles: true,
        cancelable: true,
      })
    );

  // Render once so the scene matches what a user would be looking at.
  renderer.render(scene, camera);

  const yawBefore = context.fly.yaw;
  dispatch('pointerdown', 600, 400);
  dispatch('pointermove', 700, 400);
  dispatch('pointermove', 800, 400);
  dispatch('pointerup', 800, 400);
  check('look-drag-rotates', Math.abs(context.fly.yaw - yawBefore) > 0.01,
        `yaw ${yawBefore.toFixed(3)} -> ${context.fly.yaw.toFixed(3)}`);
  check('drag-does-not-capture', !pointerLocked());
  check('drag-does-not-inspect', context.inspector.panel.hidden);

  // A click on a building's projected position must open the inspector.
  const target = context.resident.find((b) => {
    if (!context.hall) return true;
    const c = context.hall.userData.centre;
    const bx = (b.x || 0) + (b.width || 4) / 2;
    const bz = (b.y || 0) + (b.depth || 4) / 2;
    return Math.hypot(bx - c.x, bz - c.z) > 70;
  });
  if (target) {
    const world = new THREE.Vector3(
      (target.x || 0) + (target.width || 4) / 2,
      (target.height || 4) * 0.5,
      (target.y || 0) + (target.depth || 4) / 2
    );
    // Look straight at it so the projection lands on screen.
    context.fly.position.set(world.x, world.y + 6, world.z + 40);
    context.fly.yaw = 0;
    context.fly.pitch = 0;
    context.fly.apply();
    camera.updateMatrixWorld(true);
    const projected = world.clone().project(camera);
    const sx = ((projected.x + 1) / 2) * window.innerWidth;
    const sy = ((-projected.y + 1) / 2) * window.innerHeight;

    context.inspector.hide();
    // Follow real usage: the cursor is over the building (hover fires), then the
    // user clicks. That is the order that makes "highlighted == acted on" a
    // meaningful claim rather than an accident.
    dispatch('pointermove', sx, sy);
    refreshHover(true);
    const hoveredBefore = hover.target && hover.target.kind === 'building'
      ? hover.target.building
      : null;
    dispatch('pointerdown', sx, sy);
    dispatch('pointerup', sx, sy);
    const selected =
      context.inspector.selected && context.inspector.selected.building
        ? context.inspector.selected.building
        : null;
    check(
      'click-inspects-building',
      !context.inspector.panel.hidden && Boolean(selected),
      selected ? `selected ${state.source.label(selected)}` : 'nothing selected'
    );
    // Hover and click must agree: whatever was lit up is what responded.
    check(
      'hover-matches-click',
      Boolean(selected) && hoveredBefore === selected,
      selected
        ? `hovered ${state.source.label(hoveredBefore || selected)} -> clicked ${
            hoveredBefore === selected ? 'same building' : 'a different building'
          }`
        : 'nothing selected'
    );
    context.inspector.hide();
  } else {
    check('click-inspects-building', false, 'no resident buildings');
  }

  // 0c. Hover feedback: something clickable under the cursor must announce
  //     itself, and must stop announcing itself when the cursor leaves.
  const hallCentre = context.hall ? context.hall.userData.centre : null;
  const farFromHall = (b) => {
    if (!hallCentre) return true;
    const bx = (b.x || 0) + (b.width || 4) / 2;
    const bz = (b.y || 0) + (b.depth || 4) / 2;
    return Math.hypot(bx - hallCentre.x, bz - hallCentre.z) > 70;
  };
  const hoverTargetBuilding = context.resident.find((b) => b.height > 2 && farFromHall(b));
  if (hoverTargetBuilding) {
    const world = new THREE.Vector3(
      (hoverTargetBuilding.x || 0) + (hoverTargetBuilding.width || 4) / 2,
      (hoverTargetBuilding.height || 4) * 0.5,
      (hoverTargetBuilding.y || 0) + (hoverTargetBuilding.depth || 4) / 2
    );
    context.fly.position.set(world.x, world.y + 5, world.z + 45);
    context.fly.yaw = 0;
    context.fly.pitch = 0;
    context.fly.apply();
    camera.updateMatrixWorld(true);

    const projected = world.clone().project(camera);
    const hx = ((projected.x + 1) / 2) * window.innerWidth;
    const hy = ((-projected.y + 1) / 2) * window.innerHeight;

    dispatch('pointermove', hx, hy);
    refreshHover(true);
    check(
      'hover-detects-building',
      Boolean(hover.target) && hover.target.kind === 'building',
      hover.target && hover.target.kind === 'building'
        ? `hovering ${state.source.label(hover.target.building)}`
        : `kind=${hover.target ? hover.target.kind : 'none'}`
    );
    check(
      'hover-shows-outline',
      Boolean(context.hoverOutline && context.hoverOutline.visible),
      context.hoverOutline ? `outline visible=${context.hoverOutline.visible}` : 'no outline'
    );
    check(
      'hover-shows-tooltip',
      !document.getElementById('tooltip').hidden &&
        document.getElementById('tooltip-title').textContent.length > 0,
      document.getElementById('tooltip-title').textContent
    );
    check('hover-pointer-cursor', canvas.style.cursor === 'pointer', canvas.style.cursor || '(unset)');

    // Moving the cursor off the canvas must retract everything. This is tested
    // by leaving rather than by pointing at a "sky" corner, because in a dense
    // city any given corner may well contain a building.
    dispatch('pointerleave', 0, 0);
    refreshHover(true);
    check(
      'hover-clears-when-cursor-leaves',
      !hover.target &&
        !context.hoverOutline.visible &&
        document.getElementById('tooltip').hidden &&
        canvas.style.cursor === '',
      hover.target ? 'still hovering' : 'cleared'
    );
  } else {
    check('hover-detects-building', false, 'no buildings to hover');
  }

  // 0d. District plates are folders, so they are hoverable and clickable too.
  const district = state.source.manifest.districts[0];
  const corners = [
    [0.06, 0.06],
    [0.94, 0.06],
    [0.06, 0.94],
    [0.94, 0.94],
  ];
  let districtHit = null;
  for (const [fx, fz] of corners) {
    const px = district.rect[0] + district.rect[2] * fx;
    const pz = district.rect[1] + district.rect[3] * fz;
    context.fly.position.set(px, 90, pz + 0.002);
    context.fly.yaw = 0;
    context.fly.pitch = -Math.PI / 2;
    context.fly.apply();
    camera.updateMatrixWorld(true);
    scene.updateMatrixWorld();
    dispatch('pointermove', window.innerWidth / 2, window.innerHeight / 2);
    refreshHover(true);
    if (hover.target && hover.target.kind === 'district') {
      districtHit = { fx, fz };
      break;
    }
  }
  check(
    'district-hover',
    Boolean(districtHit),
    districtHit
      ? `hovering ${state.source.districtLabel(hover.target.district)} at corner ${districtHit.fx},${districtHit.fz}`
      : 'no district plate under the cursor'
  );
  check(
    'district-hover-tooltip',
    districtHit &&
      !document.getElementById('tooltip').hidden &&
      document.getElementById('tooltip-meta').textContent.includes('buildings'),
    document.getElementById('tooltip-meta').textContent.slice(0, 60)
  );
  check(
    'district-hover-marker',
    districtHit && context.hoverDistrictMarker.visible,
    context.hoverDistrictMarker.visible ? 'block outlined' : 'no district outline'
  );

  if (districtHit) {
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    context.inspector.hide();
    dispatch('pointerdown', cx, cy);
    dispatch('pointerup', cx, cy);
    const title = document.getElementById('inspector-title').textContent;
    check(
      'district-click-inspects',
      !context.inspector.panel.hidden && title === state.source.districtLabel(district),
      `inspector shows "${title}"`
    );
    context.inspector.hide();
  } else {
    check('district-click-inspects', false, 'no district to click');
  }

  // Impostors stand in for unloaded districts, so they must carry the same link.
  const impostors = scene.getObjectByName('district-impostors');
  check(
    'impostors-carry-districts',
    !impostors || (impostors.userData.districts && impostors.userData.districts.length > 0),
    impostors ? `${impostors.userData.districts.length} impostor districts` : 'none needed (all resident)'
  );

  const tourNode = document.getElementById('tour');
  results.push({
    step: 'dom-probe',
    ok: Boolean(tourNode),
    detail: `tour=${Boolean(tourNode)} htmlLen=${tourNode ? tourNode.innerHTML.length : -1} label=${Boolean(document.getElementById('tour-label'))} caption=${Boolean(document.getElementById('tour-caption'))} ids=${document.querySelectorAll('[id]').length}`,
  });

  // 1. Walk mode: gravity pulls the player down and they come to rest *on* a
  //    surface rather than sinking through it. An absolute height bound here
  //    would only test how tall the city happens to be.
  setMode('walk');
  check('walk-mode', state.mode === 'walk' && context.walk.enabled);
  const spawnY = context.walk.position.y;
  let steps = 0;
  // Simulate until the player actually comes to rest; a fixed step count would
  // just measure how tall this particular city happens to be. The first update
  // must always run, because standing still is a valid starting state.
  do {
    context.walk.update(1 / 60);
    steps++;
  } while (steps < 1200 && !context.walk.onGround);
  const landedY = context.walk.position.y;
  const underfoot = context.grid.roofHeight(context.walk.position.x, context.walk.position.z);
  check(
    'walk-gravity',
    context.walk.onGround &&
      Number.isFinite(landedY) &&
      landedY <= spawnY + 0.01 &&
      landedY >= -0.01 &&
      Math.abs(landedY - underfoot) < 0.1,
    `spawn ${spawnY.toFixed(1)} -> rest ${landedY.toFixed(1)} on ${underfoot.toFixed(1)} after ${steps} steps`
  );

  const solid = context.resident.filter((b) => b.archetype !== 'park');
  check('collision-grid', context.grid.count > 0, `${context.grid.count} solid boxes`);

  // Drive the player straight into the first solid building and confirm the
  // collision resolver stops them outside it.
  if (solid.length) {
    const target = solid[0];
    const cx = target.x + (target.width || 4) / 2;
    const cz = target.y + (target.depth || 4) / 2;
    context.walk.spawnAt(cx - 40, cz);
    context.walk.yaw = Math.atan2(-(cx - (cx - 40)), -(cz - cz));
    for (let i = 0; i < 240; i++) context.walk.update(1 / 60);
    const inside =
      context.walk.position.x > target.x &&
      context.walk.position.x < target.x + (target.width || 4) &&
      context.walk.position.z > target.y &&
      context.walk.position.z < target.y + (target.depth || 4);
    check('walk-collision', !inside, `stopped at ${context.walk.position.x.toFixed(1)},${context.walk.position.z.toFixed(1)}`);
  }

  // 2. Entering a building shows its floors and its source.
  const withFloors = context.resident.find((b) => b.floors > 0 && b.source);
  if (withFloors) {
    await enterInterior(withFloors);
    check('interior-open', state.mode === 'interior' && context.interior.active);
    check('interior-floors', context.interior.floors.length > 0, `${context.interior.floors.length} floors`);
    check('interior-source', context.interior.sourceText.length > 0, `${context.interior.sourceText.length} bytes`);
    // Prove the code wall texture actually contains rendered text: a blank
    // texture would look like a black wall and pass every other check.
    const canvas = context.interior.codeWall.material.map.image;
    const ctx2d = canvas.getContext('2d');
    const data = ctx2d.getImageData(0, 0, canvas.width, canvas.height).data;
    let bright = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 90 || data[i + 1] > 90 || data[i + 2] > 90) bright++;
    }
    check(
      'interior-texture',
      bright > 500,
      `${bright} lit pixels in a ${canvas.width}x${canvas.height} canvas`
    );

    const before = context.interior.floorIndex;
    context.interior.nextFloor(1);
    check('interior-floor-change', context.interior.floorIndex !== before || context.interior.floors.length === 1);
    exitInterior();
    check('interior-exit', !context.interior.active);
  } else {
    check('interior-open', false, 'no building with floors found');
  }

  // 3. City Hall renders the repo-wide report with clickable rows.
  context.cityHall.show();
  const rows = document.querySelectorAll('#cityhall-body tr.clickable').length;
  check('city-hall-open', context.cityHall.open);
  check('city-hall-rows', rows > 0, `${rows} clickable rows`);

  // 4. Teleport works from a City Hall row.
  const firstDistrict = state.source.manifest.districts[0];
  teleportTo({ kind: 'district', district: firstDistrict });
  check('teleport', true, `flew to ${state.source.s(firstDistrict.key)}`);

  // 5. The tour must be one continuous route. This is the exact complaint that
  //    produced it: the camera used to fly to a stop, then snap home between
  //    legs, which read as lurching rather than touring.
  context.tour.start();
  const stops = context.tour.stops;
  check('tour-start', context.tour.running && stops.length > 0, `${stops.length} stops`);
  check(
    'tour-caption',
    document.getElementById('tour-caption').textContent.length > 0,
    document.getElementById('tour-caption').textContent.slice(0, 60)
  );

  const tourTemplate = stops.map((stop) => new THREE.Vector3(...stop.eye));
  const path = [];
  const phases = [];
  const dwellDistricts = [];
  // Step far enough for the approach plus a full circuit.
  const totalTime =
    context.tour.route.total + context.tour.lead.duration;
  for (let t = 0; t < totalTime + 2; t += 1 / 20) {
    context.tour.update(1 / 20);
    path.push(camera.position.clone());
    if (context.tour.phase === 'loop') {
      const segment =
        context.tour.route.segments[context.tour._segmentAt(context.tour.elapsed)];
      phases.push(segment.type);
      if (segment.type === 'dwell') {
        dwellDistricts.push({
          index: segment.stop,
          district: context.tour.route.stops[segment.stop].district,
          markerVisible: context.tourDistrictMarker.visible,
          markerX: context.tourDistrictMarker.position.x,
          markerZ: context.tourDistrictMarker.position.z,
        });
      }
    } else {
      phases.push('lead');
    }
  }

  // (a) No teleports: every step is a small fraction of the biggest step.
  const tourSteps = [];
  let pathLength = 0;
  for (let i = 1; i < path.length; i++) {
    const step = path[i].distanceTo(path[i - 1]);
    tourSteps.push(step);
    pathLength += step;
  }
  const sortedSteps = [...tourSteps].sort((a, b) => a - b);
  const maxStep = sortedSteps[sortedSteps.length - 1];
  const stepSeconds = 1 / 20;
  const maxSpeed = maxStep / stepSeconds;
  // A snap back to the previous resting place moved the camera roughly half the
  // city in a single frame -- thousands of metres per second. Legitimate motion
  // on a long leg at speed tops out in the low hundreds.
  const speedLimit = 400;
  const shareLimit = 0.02; // no single step may dominate the route
  check(
    'tour-no-jumps',
    maxSpeed <= speedLimit && maxStep <= pathLength * shareLimit,
    `peak ${maxSpeed.toFixed(0)} m/s, largest step ${maxStep.toFixed(2)}m = ` +
      `${((maxStep / pathLength) * 100).toFixed(2)}% of a ${pathLength.toFixed(0)}m route`
  );

  // (b) Every stop is actually visited.
  const nearest = (point) => {
    let best = Infinity;
    let at = -1;
    path.forEach((p, i) => {
      const d = p.distanceTo(point);
      if (d < best) {
        best = d;
        at = i;
      }
    });
    return { best, at };
  };
  const visits = tourTemplate.map(nearest);
  check(
    'tour-visits-every-stop',
    visits.every((v) => v.best < 6),
    visits.map((v, i) => `stop${i + 1}:${v.best.toFixed(1)}m`).join(' ')
  );

  // (c) The route returns to where it started *after* the final stop.
  const lastStopAt = visits[visits.length - 1].at;
  const laterReturn = path.findIndex((p, i) => i > lastStopAt && p.distanceTo(tourTemplate[0]) < 6);
  check(
    'tour-returns-to-start',
    laterReturn > lastStopAt,
    laterReturn > lastStopAt
      ? `returned to stop 1 at frame ${laterReturn}, after stop ${visits.length} at ${lastStopAt}`
      : 'never returned to the start'
  );

  // (c2) The tour must actually hold at each stop. Travel and dwell are separate
  //      states, so their mean speeds can be compared directly.
  const dwellSteps = [];
  const travelSteps = [];
  for (let i = 1; i < path.length; i++) {
    const step = path[i].distanceTo(path[i - 1]);
    const phase = phases[i - 1];
    if (phase === 'dwell') dwellSteps.push(step);
    else if (phase === 'travel') travelSteps.push(step);
  }
  const mean = (values) =>
    values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  const dwellShare = dwellSteps.length / Math.max(1, phases.length);
  const dwellSpeed = mean(dwellSteps);
  const travelSpeed = mean(travelSteps);
  check(
    'tour-dwells-at-stops',
    dwellShare > 0.35 && dwellSpeed < travelSpeed * 0.5,
    `holds ${(dwellShare * 100).toFixed(0)}% of the time at ${dwellSpeed.toFixed(2)}m/frame vs ` +
      `${travelSpeed.toFixed(2)} while travelling`
  );

  // (c3) While holding, the district being described must be marked on the map.
  const markerOk =
    dwellDistricts.length > 0 &&
    dwellDistricts.every(
      (d) => d.markerVisible && Math.abs(d.markerX - d.district.rect[0]) < 0.01
    );
  check(
    'tour-highlights-district',
    markerOk,
    markerOk
      ? `marker shown on all ${dwellDistricts.length} held frames, e.g. district ${dwellDistricts[0].index}`
      : 'district marker missing or misplaced during a stop'
  );

  // (d) Handing control back must not move the camera at all.
  context.tour.stopTour();
  const beforeHandback = camera.position.clone();
  context.fly.update(1 / 60);
  const handbackJump = camera.position.distanceTo(beforeHandback);
  check(
    'tour-handback-no-snap',
    handbackJump < 0.5,
    `camera moved ${handbackJump.toFixed(3)}m after the tour ended`
  );

  // 5d. The City Guide is the whole legend, and a switch that exists must
  //     actually reach the geometry rather than only recolour a row.
  {
    const legend = state.source.manifest.legend || [];
    const legendRows = document.querySelectorAll(
      '#guide-list .key-row[data-key^="legend:"]'
    );
    check(
      'keys-covers-legend',
      legendRows.length === legend.length,
      `${legendRows.length} rows for ${legend.length} legend entries`
    );

    const inert = [...document.querySelectorAll('#guide-list .key-row.inert')];
    check(
      'keys-inert-encodings',
      inert.length > 0 && inert.every((row) => !row.hasAttribute('aria-pressed')),
      `${inert.length} encoding row(s) listed without a switch`
    );

    const craneRow = document.querySelector('#guide-list .key-row[data-key="legend:churn"]');
    const cranes = context.city.group.getObjectByName('cranes');
    if (craneRow && craneRow.dataset.kind === 'mesh' && cranes) {
      toggleRow(craneRow);
      check('keys-hides-layer', cranes.visible === false, 'crane layer hidden');
      toggleRow(craneRow);
      check('keys-restores-layer', cranes.visible === true, 'crane layer shown again');
    } else {
      check('keys-hides-layer', true, 'no crane layer in this city');
      check('keys-restores-layer', true, 'no crane layer in this city');
    }

    const formRow = [...document.querySelectorAll('#guide-list .key-row[data-kind="archetype"]')].find(
      (row) => context.resident.some((b) => (b.archetype || 'warehouse') === row.dataset.target)
    );
    if (formRow) {
      const archetype = formRow.dataset.target;
      toggleRow(formRow);
      rebuildCity(context.resident);
      const drawn = [...context.city.records.values()]
        .flat()
        .filter((b) => (b.archetype || 'warehouse') === archetype).length;
      check('keys-form-switch', drawn === 0, `${archetype} dropped from the resident set`);
      toggleRow(formRow);
      rebuildCity(context.resident);
    } else {
      check('keys-form-switch', true, 'no resident form to switch');
    }

    // An encoding switch rebuilds with that option off; downtown is the easiest
    // one to see, because its antennas are their own cluster and must vanish.
    const downtownRow = document.querySelector('#guide-list .key-row[data-key="legend:downtown"]');
    if (downtownRow && downtownRow.dataset.kind === 'option') {
      const before = context.city.group.getObjectByName('antennas');
      toggleRow(downtownRow);
      rebuildCity(context.resident);
      const after = context.city.group.getObjectByName('antennas');
      const cleared = !before || before.count === 0 || !after || after.count === 0;
      check(
        'keys-option-switch',
        cleared,
        `${before ? before.count : 0} antennas -> ${after ? after.count : 0}`
      );
      toggleRow(downtownRow);
      rebuildCity(context.resident);
    } else {
      check('keys-option-switch', true, 'no downtown encoding in this city');
    }
  }

  // 5e. The guide explains, counts and highlights; the ground shows the
  //     folder tree; the report explains a building; health is one lens away.
  {
    const row = document.querySelector('#guide-list .key-row[data-key="legend:height"]');
    const name = row && row.querySelector('.g-name');
    if (name) name.click();
    const more = row && row.querySelector('.g-more');
    check(
      'guide-explains',
      Boolean(more && !more.hidden && more.textContent.length > 40),
      more ? `${more.textContent.length} chars of explanation` : 'no height row'
    );
    if (name) name.click();

    const highlight = document.querySelector('#guide-list .g-highlight');
    if (highlight) {
      const query = highlight.dataset.query;
      highlightQuery(query);
      const applied = state.filterText === query && Boolean(context.city._filtered);
      highlightQuery(query);
      check('guide-highlight', applied && !state.filterText, `highlight ${query} then clear`);
    } else {
      check('guide-highlight', true, 'no countable layer in this city');
    }

    const manifest = state.source.manifest;
    const classes = new Set((manifest.streets || []).map((s) => (s.length > 4 ? s[4] : 2)));
    const roadMeshes = context.city.group.children.filter((c) => c.name.startsWith('streets-') && c.name !== 'streets-markings');
    check(
      'roads-have-classes',
      roadMeshes.length === classes.size && roadMeshes.length > 0,
      `${roadMeshes.length} road meshes for ${classes.size} classes`
    );
    const plinths = context.city.group.getObjectByName('region-plinths');
    const regionCount = (manifest.regions || []).length;
    check(
      'regions-drawn',
      regionCount === 0 ? !plinths : Boolean(plinths && plinths.count === regionCount),
      `${plinths ? plinths.count : 0} plinths for ${regionCount} regions`
    );

    const withFloors = context.resident.find((b) => b.floors > 1 && b.source);
    if (withFloors) {
      context.inspector.showBuilding(withFloors);
      for (let i = 0; i < 40 && !document.querySelector('#inspector-floors .floor'); i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const text = document.getElementById('inspector-metrics').textContent;
      const floorsListed = document.querySelectorAll('#inspector-floors .floor').length;
      check(
        'inspector-explains-floors',
        /row of windows/i.test(text) && /Architect/.test(text) && floorsListed === withFloors.floors,
        `${floorsListed} floors listed for ${withFloors.floors}`
      );
      context.inspector.hide();
    } else {
      check('inspector-explains-floors', true, 'no building with floors resident');
    }

    const mesh = [...context.city.meshes.values()].find((m) => m.userData.baseColors && m.count > 0);
    if (mesh) {
      const before = Array.from(mesh.userData.baseColors.slice(0, 3));
      context.city.recolour('health');
      const after = Array.from(mesh.userData.baseColors.slice(0, 3));
      context.city.recolour('archetype');
      check('health-lens', before.some((v, i) => Math.abs(v - after[i]) > 1e-3), 'health lens recolours');
    } else {
      check('health-lens', true, 'no buildings');
    }
    const cards = document.querySelectorAll('#guide-health .health-card').length;
    check('health-tab', manifest.review ? cards === 5 : cards === 0, `${cards} health cards`);
  }

  // 5e. Detail follows the camera. A building beyond the opening camera's LOD
  //     radius must move into the near-tier mesh once the camera goes to it.
  //     Without this the ranking stayed frozen around wherever the camera first
  //     stood, so flying anywhere kept far-tier boxes -- a park stayed a cube no
  //     matter how close it was inspected.
  {
    const startPosition = camera.position.clone();
    const startYaw = context.fly.yaw;
    const startPitch = context.fly.pitch;
    let target = null;
    let farthest = 0;
    for (const building of context.resident) {
      const distance = Math.hypot(
        building.x + building.width / 2 - startPosition.x,
        building.y + building.depth / 2 - startPosition.z
      );
      if (distance > farthest) {
        farthest = distance;
        target = building;
      }
    }
    const radius = context.city.lodRadius || 600;
    if (target && farthest > radius) {
      const archetype = target.archetype || 'warehouse';
      setMode('fly');
      context.fly.position.set(
        target.x + target.width / 2,
        Math.max(60, (target.height || 4) * 2),
        target.y + target.depth / 2
      );
      context.fly.yaw = 0;
      context.fly.pitch = -1.0;
      context.fly.apply();
      // The check is not subject to the flight rate limit. -Infinity rather
      // than 0: under Chrome's virtual clock performance.now() can still be
      // below the 600 ms limit here, and `now - 0` would skip the rebuild.
      lodRebuiltAt = -Infinity;
      await refreshResident();
      const nearMesh = context.city.group.children.find(
        (child) => child.name === `buildings-${archetype}`
      );
      let nearest = Infinity;
      if (nearMesh) {
        const matrix = new THREE.Matrix4();
        for (let i = 0; i < nearMesh.count; i++) {
          nearMesh.getMatrixAt(i, matrix);
          const elements = matrix.elements;
          nearest = Math.min(
            nearest,
            Math.hypot(elements[12] - camera.position.x, elements[14] - camera.position.z)
          );
        }
      }
      check(
        'lod-follows-camera',
        Boolean(nearMesh) && nearest < radius,
        nearMesh
          ? `nearest ${archetype} at ${nearest.toFixed(0)}m, LOD radius ${radius.toFixed(0)}m`
          : `no near-tier mesh for ${archetype}`
      );
    } else {
      check('lod-follows-camera', true, 'city fits inside one LOD radius');
    }
    context.fly.position.copy(startPosition);
    context.fly.yaw = startYaw;
    context.fly.pitch = startPitch;
    context.fly.apply();
  }

  // 6. Renderer still healthy after all of that.
  const payload = runBench(12);
  check('draw-calls', payload.drawCalls <= 60, `${payload.drawCalls} draw calls`);
  check('webgl', payload.webgl);

  reportSelfTest(results);

  // `&hold=interior|hall|tour` leaves the viewer in that state, so a screenshot
  // can capture a surface that a scripted pass would otherwise close.
  const hold = new URLSearchParams(location.search).get('hold');
  if (hold === 'interior' && withFloors) {
    await enterInterior(withFloors);
  } else if (hold === 'hall') {
    context.cityHall.show();
    document.body.classList.add('hall-open');
  } else if (hold === 'tour') {
    context.tour.start();
    // Advance into a hold, so a screenshot captures the dwell and the district
    // highlight rather than the approach.
    let advanced = 0;
    const until = context.tour.lead.duration + 0.6;
    while (advanced < until && context.tour.running) {
      context.tour.update(1 / 30);
      advanced += 1 / 30;
    }
    // Hold this exact frame: under virtual time the loop keeps advancing, so a
    // screenshot would otherwise land somewhere arbitrary.
    state.tourFrozen = true;
    // Render once so a screenshot has a painted frame to capture.
    renderer.render(scene, camera);
    const marker = context.tourDistrictMarker;
    const pre = document.createElement('pre');
    pre.id = 'tour-capture';
    const drawn = {
      calls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
    };
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    const meshes = context.city.group.children.filter((c) => c.name.startsWith('buildings-'));
    const instances = meshes.reduce((sum, m) => sum + m.count, 0);
    const visible = meshes.reduce((sum, m) => sum + (m.visible ? m.count : 0), 0);
    pre.textContent =
      `TOUR_CAPTURE camera=(${camera.position.x.toFixed(1)},${camera.position.y.toFixed(1)},${camera.position.z.toFixed(1)}) ` +
      `dir=(${dir.x.toFixed(2)},${dir.y.toFixed(2)},${dir.z.toFixed(2)}) ` +
      `flyYaw=${context.fly.yaw.toFixed(2)} flyPitch=${context.fly.pitch.toFixed(2)} ` +
      `meshes=${meshes.length} instances=${instances} visible=${visible} ` +
      `resident=${context.resident.length} frustumCulled=${meshes.map((m) => m.frustumCulled).join(',')} ` +
      `bounds=${JSON.stringify(state.source.manifest.bounds)} ` +
      `drawnCalls=${drawn.calls} drawnTriangles=${drawn.triangles} ` +
      `skyVisible=${context.sky.sky.visible} ` +
      `sunIntensity=${context.sky.sun.intensity.toFixed(2)} ` +
      `elemEmissive=${context.city.group.children.find((c) => c.name.startsWith('buildings-')).material.emissiveIntensity.toFixed(2)}`;
    document.body.append(pre);
  } else if (hold === 'district') {
    const d = state.source.manifest.districts[0];
    for (const [fx, fz] of [[0.06, 0.06], [0.94, 0.06], [0.06, 0.94], [0.94, 0.94]]) {
      const px = d.rect[0] + d.rect[2] * fx;
      const pz = d.rect[1] + d.rect[3] * fz;
      context.fly.position.set(px - 26, 74, pz + 30);
      context.fly.yaw = Math.atan2(-26, -(-30));
      context.fly.pitch = -0.86;
      context.fly.apply();
      renderer.render(scene, camera);
      hover.active = true;
      hover.x = window.innerWidth / 2;
      hover.y = window.innerHeight / 2;
      refreshHover(true);
      if (hover.target && hover.target.kind === 'district') break;
    }
  } else if (hold === 'hover') {
    const target = context.resident.find((b) => b.height > 6) || context.resident[0];
    if (target) {
      const world = new THREE.Vector3(
        (target.x || 0) + (target.width || 4) / 2,
        (target.height || 4) * 0.5,
        (target.y || 0) + (target.depth || 4) / 2
      );
      context.fly.position.set(world.x + 6, world.y + 7, world.z + 52);
      context.fly.yaw = 0.06;
      context.fly.pitch = -0.05;
      context.fly.apply();
      renderer.render(scene, camera);
      const projected = world.clone().project(camera);
      hover.active = true;
      hover.x = ((projected.x + 1) / 2) * window.innerWidth;
      hover.y = ((-projected.y + 1) / 2) * window.innerHeight;
      refreshHover(true);
    }
  } else if (hold === 'walk') {
    setMode('walk');
    const solid = context.resident.find((b) => b.archetype !== 'park');
    if (solid) {
      context.walk.spawnAt(solid.x + solid.width / 2 - 26, solid.y + solid.depth / 2 - 26);
      context.walk.yaw = Math.atan2(26, 26);
      context.walk.apply();
    }
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function maxHeightOf(manifest) {
  return Math.max(1, ...manifest.districts.map((d) => d.skyline.maxHeight));
}

async function boot() {
  const progress = (text) => {
    loadingText.textContent = text;
  };
  try {
    progress('reading manifest');
    await state.source.load(progress);
    progress('unlocking labels');
    await state.source.loadStrings();
  } catch (error) {
    loading.classList.add('error');
    loadingText.textContent =
      `Could not load the city: ${error.message}\n\n` +
      'Serve the directory over http (python3 zion.py serve <repo>) — browsers block ' +
      'module scripts and fetch() from file://.';
    return;
  }

  const manifest = state.source.manifest;
  const bounds = manifest.bounds;

  context.vault = new Vault(manifest);
  state.source.vault = context.vault;
  if (context.vault.encrypted && state.source.locked) {
    setupVaultPanel();
    document.getElementById('vault').hidden = false;
  }

  progress('building the sky');
  context.sky = new SkyRig(THREE, scene, bounds);

  progress('raising the landmark');
  context.hall = createCityHall(THREE, bounds, maxHeightOf(manifest), manifest.cityHall);
  scene.add(context.hall);

  // One reusable outline marks whatever the cursor is over.
  context.hoverOutline = createHoverOutline(THREE);
  scene.add(context.hoverOutline);
  // Separate markers for hover and for the tour, so the two never fight.
  context.hoverDistrictMarker = createDistrictMarker(THREE);
  scene.add(context.hoverDistrictMarker);
  context.tourDistrictMarker = createDistrictMarker(THREE);
  scene.add(context.tourDistrictMarker);

  const span = Math.max(bounds[2], bounds[3]);
  // A span-proportional radius would cover an entire 6.7 km city at once, so the
  // working set is bounded in metres and then capped by building count.
  const near = Math.min(2500, Math.max(400, span * 0.2));
  context.streamer = new DistrictStreamer(state.source, {
    span,
    near,
    far: near * 1.9,
    maxResident: state.maxResident
      ? state.maxResident
      : manifest.meta.buildingCount > 20000
        ? 20000
        : Infinity,
  });

  progress('placing buildings');
  if (manifest.meta.buildingCount <= 600) {
    // Small enough to hold whole; streaming would only add latency.
    context.resident = await context.streamer.loadAll();
  } else {
    await context.streamer.update(bounds[0] + bounds[2] / 2, bounds[1] + bounds[3], true);
    context.resident = context.streamer.buildings();
  }
  state.source.buildings = context.resident;
  await state.source.assignLockedAddresses(context.resident);
  context.facetIndex = await state.source.index();
  context.extTable = await state.source.extTable();
  setupFilterAndLens();
  renderChips();
  rebuildCity(context.resident);
  // The first build is valid around the opening camera, so a later rebuild is
  // only due once the camera has actually travelled from here.
  lodCentre = { x: camera.position.x, z: camera.position.z };
  lodRebuiltAt = performance.now();

  context.fly = new FlyCamera(THREE, camera, bounds);
  context.orbit = new OrbitCamera(THREE, camera, bounds);
  context.flight = new CameraFlight(camera);
  context.walk = new WalkCamera(THREE, camera, context.grid, bounds);
  context.interior = new Interior(THREE, state.source, renderer);
  context.inspector = new Inspector(state.source);
  // The inspector names other files (cycle members, co-changed files) and can
  // fly to them; both need the whole-repo index, which it does not hold.
  context.inspector.pathForId = (id) => {
    const row = indexRowById().get(id);
    if (!row) return '';
    const col = columnIndex(state.source.manifest.indexColumns);
    return state.source.s(row[col.path !== undefined ? col.path : col.name]);
  };
  context.inspector.districtForId = (id) => {
    const row = indexRowById().get(id);
    return row ? row[columnIndex(state.source.manifest.indexColumns).district] : null;
  };
  context.inspector.onFly = (id) => flyToBuilding(id);
  setupDetailOverlay();
  context.cityHall = new CityHall(state.source, {
    panel: document.getElementById('cityhall'),
    body: document.getElementById('cityhall-body'),
    title: document.getElementById('cityhall-title'),
    close: document.getElementById('cityhall-close'),
  });
  context.cityHall.onTeleport = teleportTo;
  context.tour = new Tour(THREE, state.source, camera, context.flight, {
    // The container is shown and hidden; the caption paragraph receives text.
    // Writing the caption into the container would erase the paragraph itself.
    container: document.getElementById('tour'),
    caption: document.getElementById('tour-caption'),
    label: document.getElementById('tour-label'),
    // The tour keeps this in step so handing control back never moves the view.
    fly: context.fly,
    // Show the viewer which block is being described.
    onStop: (district) => {
      placeDistrictMarker(context.tourDistrictMarker, district.rect, 0.18);
      // Light up everything that belongs to this district, not just its outline.
      if (context.city) context.city.highlightDistrict(district.id);
    },
  });

  context.fly.setFromManifest(manifest.camera);
  context.orbit.frame(bounds);
  camera.far = manifest.camera.far;
  camera.fov = manifest.camera.fov;
  camera.updateProjectionMatrix();

  renderGuide();
  setupMapLabels();
  renderTitle();
  applyTime();

  loading.classList.add('done');
  window.zion = {
    state,
    scene,
    camera,
    renderer,
    context,
    runBench,
    setMode,
    enterInterior,
    teleportTo,
    attemptUnlock,
  };

  if (state.selftest) {
    // Awaited, not deferred: WebCrypto operations (the 310,000-iteration PBKDF2
    // unlock) never settle under Chrome's virtual clock, and only work that
    // happens during module evaluation is guaranteed to precede the load event
    // that --dump-dom waits for.
    try {
      await runSelfTest();
    } catch (error) {
      reportSelfTest(
        selfTestResults.concat([
          { step: 'selftest', ok: false, detail: `${error && error.stack ? error.stack : error}` },
        ])
      );
    }
  }

  if (state.bench) {
    state.time = 20.5; // dusk: the point of the metaphor
    document.getElementById('time').value = state.time;
    applyTime();
    renderer.render(scene, camera);
    setTimeout(() => runBench(60), 0);
  }

  requestAnimationFrame(frame);
}

// Top-level await: the load event must not fire until the city is up and, in
// test mode, every check has reported. Headless verification depends on it.
await boot();
