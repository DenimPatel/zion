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
  DELTA_COLOURS,
  LENS_BANDS,
  lensBand,
  lensColour,
  categoryColour,
  MAIN_SEQUENCE_BANDS,
  mainSequenceBand,
  healthSignal,
  plinthTop,
} from './city.js';
import { SkyRig } from './sky.js';
import { FlyCamera, OrbitCamera, TopCamera, CameraFlight } from './cameras.js';
import { CollisionGrid, WalkCamera } from './collision.js';
import { Interior } from './interior.js';
import { CityHall, Tour } from './tour.js';
import { DistrictStreamer } from './stream.js';
import { Vault } from './vault.js';
import { Inspector } from './inspector.js';
import { FLAG_BITS, buildFacets, columnIndex, edgeMaps, parseQuery, runQuery } from './facets.js';
import { SelectionOverlay, PlanFlows, LINK_COLOURS, IMPACT_COLOURS, blastRadius } from './selection.js';
import { Notes } from './notes.js';
import { captureView, copyText, viewFromHash, viewToHash } from './views.js';
import { MapLabels } from './labels.js';
import { MiniMap } from './minimap.js';
import { GoToPalette } from './palette.js';
import { renderBuilding, renderDistrict, resetDetailPanel } from './detail.js';

const canvas = document.getElementById('scene');
const loading = document.getElementById('loading');
const loadingText = document.getElementById('loading-text');
const promptEl = document.getElementById('prompt');

const params = new URLSearchParams(location.search);

// Legend layers that start switched off: scaffolding covers thousands of
// buildings in an active repo and hides the massing, so it is opt-in.
const DEFAULT_HIDDEN_LAYERS = ['new_construction'];

const state = {
  source: new CitySource('.'),
  mode: 'fly', // fly | walk | orbit | top | interior
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
  // kept here by hand. Starts from DEFAULT_HIDDEN_LAYERS.
  hiddenLayers: new Set(DEFAULT_HIDDEN_LAYERS),
  // Folders the current district/region selection focuses on (S14): every
  // building outside them fades, the way a filter fades non-matches.
  focus: null,
  // The History slider: days before the newest commit, or null for today.
  timeline: null,
  // The author the territory lens paints.
  territoryAuthor: '',
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
  top: null,
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
  skybridges: { kind: 'overlay', target: 'cochange-rings', short: 'Co-change rings', colour: LINK_COLOURS.cochange },
  hotspots: { kind: 'mesh', target: 'hazard-barriers', short: 'Hazard barriers — hotspots', colour: HEALTH_COLOURS.hotspot, query: 'is:hotspot' },
  oversized: { kind: 'mesh', target: 'raking-shores', short: 'Buttresses — oversized', colour: HEALTH_COLOURS.oversized, query: 'is:oversized' },
  orphans: { kind: 'option', short: 'Boarded up — orphans', colour: HEALTH_COLOURS.orphan, query: 'is:orphan' },
  cycles: { kind: 'mesh', target: 'cycle-pennants', short: 'Pennants — import cycles', colour: HEALTH_COLOURS.cycle, query: 'is:cycle' },
  knowledge: { kind: 'mesh', target: 'knowledge-flags', short: 'Red flags — owner gone', colour: 0xe8332a, query: 'is:knowledge' },
  untested: { kind: 'mesh', target: 'traffic-cones', short: 'Traffic cones — untested risk', colour: 0xff6a1a, query: 'is:untestedrisk' },
  complexity: { kind: 'mesh', target: 'cross-bracing', short: 'Cross-bracing — branch-heavy', colour: 0xb8c2cc, query: 'is:braced' },
  imports: { kind: 'overlay', target: 'import-lines', short: 'Utility lines — imports', colour: LINK_COLOURS.out, query: 'fanout>0' },
  impact: { kind: 'overlay', target: 'impact-rings', short: 'Flood map — blast radius', colour: IMPACT_COLOURS[0], query: 'impact>0' },
  main_sequence: { kind: null, short: 'Main sequence', colour: 0xc77dff, reason: 'folder inspector and City Hall', query: 'zone:pain OR zone:useless' },
  externals: { kind: null, short: 'Harbour — packages', colour: 0x3f8fb0, reason: 'listed in the inspector and City Hall, not drawn' },
  instability: { kind: null, short: 'Instability', colour: 0xd9b44a, reason: 'a colour lens: Filter tab → instability' },
  violations: { kind: 'mesh', target: 'no-entry-signs', short: 'No-entry signs — layering', colour: HEALTH_COLOURS.violation, query: 'is:violation' },
  district_coupling: { kind: 'overlay', target: 'district-links', short: 'Folder links', colour: LINK_COLOURS.cochange },
  codeowners: { kind: 'mesh', target: 'owner-notices', short: 'Owner notices — CODEOWNERS drift', colour: 0x8c5ce6, query: 'is:drift' },
  experts: { kind: null, short: 'Who to ask', colour: 0xb28ad6, reason: 'listed in the inspector, not drawn' },
  delta: { kind: 'mesh', target: 'survey-stakes', short: 'Survey stakes — changed', colour: DELTA_COLOURS.added, query: 'is:added OR is:grown OR is:shrunk' },
  timeline: { kind: null, short: 'History', colour: 0xe8b04b, reason: 'the History slider replays it' },
  bugprone: { kind: 'mesh', target: 'smoke-plumes', short: 'Smoke — bug-prone', colour: HEALTH_COLOURS.bugprone, query: 'is:bugprone' },
  debt: { kind: 'mesh', target: 'potholes', short: 'Potholes — debt markers', colour: HEALTH_COLOURS.debt, query: 'is:debt' },
  codes: { kind: 'mesh', target: 'code-notices', short: 'Code notices — building codes', colour: HEALTH_COLOURS.codes, query: 'is:codes' },
  defects: { kind: 'mesh', target: 'defect-lamps', short: 'Warning lamps — defect-prone', colour: HEALTH_COLOURS.defect, query: 'is:defect' },
  hubs: { kind: 'mesh', target: 'hub-collars', short: 'Steel collars — hubs', colour: HEALTH_COLOURS.hub, query: 'is:hub' },
  trend: { kind: null, short: 'Trend', colour: 0xff8a3d, reason: 'a colour lens: Filter tab → trend', query: 'is:warming' },
  hidden_coupling: { kind: 'overlay', target: 'hidden-arcs', short: 'Dashed arcs — hidden coupling', colour: LINK_COLOURS.hidden, query: 'is:hiddencoupling' },
  clones: { kind: 'overlay', target: 'clone-links', short: 'Twin links — copied code', colour: LINK_COLOURS.clone, query: 'is:clone' },
  abstractness: { kind: null, short: 'Main sequence', colour: 0x2f9e6e, reason: 'City Hall charts it; Filter tab → main sequence' },
  teams: { kind: null, short: 'Coordination cost', colour: 0xb28ad6, reason: 'listed in the folder inspector, not drawn' },
  grades: { kind: 'overlay', target: 'grade-badges', short: 'Grade badges — folder health', colour: 0x3ddc84 },
  plan_flows: { kind: 'overlay', target: 'plan-flows', short: 'Folder arrows — plan view', colour: LINK_COLOURS.out },
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
  const predicate = compileQuery(query);
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
    untested: /test/i, imports: /import/i, instability: /import/i, district_coupling: /coupling/i,
    codeowners: /CODEOWNERS/, experts: /author/i, timeline: /birth/i, defects: /fix/i,
    impact: /import/i, bugprone: /fix|repairs/i, debt: /debt|TODO/i, codes: /building codes/i, externals: /harbour|package/i,
  }[id];
  const note = words ? notes.find((n) => words.test(n)) : null;
  if (note) return note;
  if (id === 'cycles') return 'No import cycles were found.';
  if (id === 'violations') return 'No import points against the layering.';
  if (id === 'complexity') return 'No function has 15 or more decision points.';
  if (id === 'codeowners') return 'No CODEOWNERS file in the repository.';
  if (id === 'district_coupling') return 'No two folders keep changing together.';
  if (id === 'main_sequence') return 'No folder has both classes and imports in or out, so none can be placed on the main sequence.';
  if (id === 'bugprone') return 'No file has enough commits that say they fix it.';
  if (id === 'delta') return 'No baseline yet: build again after the repository changes, or build with --compare REV.';
  if (id === 'hubs') return 'No file is both widely imported and a heavy importer.';
  if (id === 'debt') return 'No TODO, FIXME, HACK or XXX comments in this repository\'s own code.';
  if (id === 'clones') return 'No two files share a long copied block.';
  if (id === 'hiddenCoupling' || id === 'hidden_coupling') return 'Every pair that changes together across folders also imports one way or the other.';
  if (id === 'trend' || id === 'rising') return 'Needs 10+ commits over at least five months to tell rising from cooling.';
  if (id === 'abstractness') return 'No folder has enough type definitions and resolved imports to place on the main sequence.';
  if (id === 'teams') return 'Needs more than one author.';
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
    reset.hidden = state.hiddenArchetypes.size === 0
      && state.hiddenLayers.size === DEFAULT_HIDDEN_LAYERS.length
      && DEFAULT_HIDDEN_LAYERS.every((id) => state.hiddenLayers.has(id));
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
  if (kind === 'mesh' || kind === 'overlay') applyHiddenLayers();
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
  // Every prop back first (the History slider may have hidden them all), then
  // each switch takes its own layer away again.
  context.city.showProps();
  for (const [id, spec] of Object.entries(LEGEND_KEYS)) {
    if (spec.kind === 'mesh') context.city.setLayerVisible(spec.target, !state.hiddenLayers.has(id));
    else if (spec.kind === 'overlay' && context.overlay) {
      context.overlay.setLayerVisible(spec.target, !state.hiddenLayers.has(id));
    }
  }
  // Grades and the plan's folder arrows live outside the city mesh.
  if (context.labels) context.labels.setGradesShown(!state.hiddenLayers.has('grades'));
  if (context.planFlows) context.planFlows.setLayerVisible('plan-flows', !state.hiddenLayers.has('plan_flows'));
  if (context.minimap) context.minimap.invalidate();
  // The History slider hides every prop while it replays the past; a switch
  // flipped meanwhile must not bring them back early.
  if (state.timeline !== null) context.city.hideProps();
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
  state.hiddenLayers = new Set(DEFAULT_HIDDEN_LAYERS);
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
  {
    id: 'violations', title: 'Layering violations', colour: HEALTH_COLOURS.violation, flag: 'layering',
    text: 'Files with an import that points the wrong way. Select one to see the red line.',
  },
  {
    id: 'untested', title: 'Untested risk', colour: 0xff6a1a, flag: 'tests',
    text: 'Hotspots, oversized and downtown files that no test imports or is named after.',
  },
  {
    id: 'complexity', title: 'Branch-heavy code', colour: 0xb8c2cc, flag: 'complexity',
    text: 'A function with 15+ decision points, worst first. Hard to test every path.',
  },
  {
    id: 'drift', title: 'CODEOWNERS drift', colour: 0x8c5ce6, flag: 'codeowners',
    text: 'The people CODEOWNERS names for these files wrote almost none of them.',
  },
  {
    id: 'impact', title: 'Widest blast radius', colour: IMPACT_COLOURS[0], flag: 'imports', column: 'impact', unit: 'files',
    text: 'A change here reaches the most files: everything that imports it, directly or through others. Select one to see the flood map.',
  },
  {
    id: 'bugprone', title: 'Bug-prone', colour: HEALTH_COLOURS.bugprone, flag: 'defects', column: 'fixes', unit: 'fixes',
    text: 'Commits keep saying they fix these files. Churn says a file changes; this says it keeps breaking.',
  },
  {
    id: 'defects', title: 'Defect-prone files', colour: HEALTH_COLOURS.defect, flag: 'defects',
    text: 'An unusually large share of their commits are fixes. Bugs cluster: the next one is likely here.',
  },
  {
    id: 'rising', title: 'Rising hotspots', colour: 0xff2d55, flag: 'trend',
    text: 'Hotspots that got busier this quarter than the one before: the refactor that gets dearer every week.',
  },
  {
    id: 'hubs', title: 'Hubs', colour: HEALTH_COLOURS.hub, flag: 'hubs',
    text: 'Imported by many and importing many: a change ripples both ways. Split along the callers.',
  },
  {
    id: 'clones', title: 'Copied code', colour: LINK_COLOURS.clone, flag: 'clones', pairs: true,
    text: 'Pairs of files sharing a long near-identical block. Fix one, and the other keeps the bug.',
  },
  {
    id: 'hiddenCoupling', title: 'Hidden coupling', colour: LINK_COLOURS.hidden, flag: 'hiddenCoupling', pairs: true,
    text: 'Pairs in different folders that change together with no import between them. Name the contract.',
  },
  {
    id: 'debt', title: 'Written-down debt', colour: HEALTH_COLOURS.debt, flag: 'debt', column: 'debt', unit: 'markers',
    text: 'TODO, FIXME, HACK and XXX in comments: the authors already said what is wrong.',
  },
  {
    id: 'codes', title: 'Building-code breaches', colour: HEALTH_COLOURS.codes, flag: 'codes',
    text: 'Files over a limit declared under "codes" in .zion/rules.json. The inspector names the limit.',
  },
];

// Extra Health cards that are not one ranked list of files.
const HEALTH_EXTRA = ['delta', 'dependencies', 'notes'];

function indexRowById() {
  if (context._rowById) return context._rowById;
  const map = new Map();
  const col = columnIndex(state.source.manifest.indexColumns);
  for (const row of context.facetIndex || []) map.set(row[col.id], row);
  context._rowById = map;
  return map;
}

function healthItem(id, column = null, unit = '') {
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
  meta.textContent = column && row && col[column] !== undefined
    ? `${Number(row[col[column]] || 0).toLocaleString()} ${unit}`
    : `${Number(loc || 0).toLocaleString()} ln`;
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
  const csv = document.createElement('button');
  csv.type = 'button';
  csv.id = 'health-csv';
  csv.className = 'chip-btn';
  csv.textContent = 'Download every file as CSV';
  csv.title = state.source.locked
    ? 'Unlock the city first: a locked city has no paths to export'
    : 'Every file with its metrics and signals, for a spreadsheet or a ticket';
  csv.disabled = state.source.locked;
  csv.addEventListener('click', () => downloadCsv());
  intro.append(document.createElement('br'), csv);
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
      } else if (section.pairs) {
        for (const pair of review[section.id] || []) {
          if (pair.length < 2) continue;
          const li = document.createElement('li');
          li.className = 'health-pair';
          li.style.borderColor = hexColour(section.colour);
          li.append(healthItem(pair[0]), document.createTextNode(' ↔ '), healthItem(pair[1]));
          list.append(li);
        }
      } else {
        for (const id of review[section.id] || []) {
          const li = document.createElement('li');
          li.append(healthItem(id, section.column, section.unit));
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
  const delta = renderDeltaCard(manifest);
  if (delta) panel.prepend(intro, delta);
  const deps = renderDependencyCard(manifest);
  if (deps) panel.append(deps);
  for (const extra of [renderZonesCard(manifest), renderHarbourCard(manifest), renderCensusCard(manifest)]) {
    if (extra) panel.append(extra);
  }
  panel.append(renderNotesCard());
}

/**
 * Every file in the repository as CSV, from index.json: the whole city, not
 * only what is resident. Flag bits are spelled out as signal names.
 */
function csvText() {
  const manifest = state.source.manifest;
  const col = columnIndex(manifest.indexColumns);
  // CSV word -> flag mask, read from facets.js so the bits live in one place.
  const names = [
    ['hotspot', 'hotspot'], ['oversized', 'oversized'], ['orphan', 'orphan'], ['cycle', 'cycle'],
    ['knowledge', 'knowledge'], ['violation', 'violation'], ['untested', 'untested'],
    ['untested-risk', 'untestedrisk'], ['drift', 'drift'], ['braced', 'braced'], ['unowned', 'unowned'],
    ['bugprone', 'bugprone'], ['debt', 'debt'], ['code-violation', 'codes'], ['defect', 'defect'],
    ['rising', 'rising'], ['hub', 'hub'], ['clone', 'clone'], ['hidden-coupling', 'hiddencoupling'],
    ['test', 'test'], ['doc', 'doc'], ['new', 'new'], ['downtown', 'downtown'],
  ].map(([name, key]) => [name, FLAG_BITS[key]]);
  const quote = (value) => {
    const text = String(value === undefined || value === null ? '' : value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const header = ['path', 'folder', 'language', 'archetype', 'loc', 'age_days', 'heat', 'owner', 'max_complexity',
    'fan_in', 'fan_out', 'fix_commits', 'trend', 'debt_markers', 'import_depth', 'loc_since_baseline', 'grade_of_folder', 'signals'];
  const lines = [header.join(',')];
  const get = (row, name) => (col[name] === undefined ? '' : row[col[name]]);
  for (const row of context.facetIndex || []) {
    const district = manifest.districts[row[col.district]];
    const flags = row[col.flags] || 0;
    const owner = get(row, 'owner');
    lines.push([
      state.source.s(row[col.path]),
      district ? state.source.s(district.key) : '',
      state.source.s(row[col.language]),
      row[col.archetype],
      get(row, 'loc'), get(row, 'age'), get(row, 'heat'),
      owner !== '' && owner >= 0 ? state.source.s(owner) : '',
      get(row, 'cx'), get(row, 'fanin'), get(row, 'fanout'), get(row, 'fixes'), get(row, 'trend'), get(row, 'debt'),
      get(row, 'depth'), get(row, 'delta'),
      district ? district.grade || '' : '',
      names.filter(([, mask]) => flags & mask).map(([name]) => name).join(' '),
    ].map(quote).join(','));
  }
  return lines.join('\n') + '\n';
}

function downloadCsv() {
  if (state.source.locked) return;
  const blob = new Blob([csvText()], { type: 'text/csv' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  const name = manifestName() || 'repository';
  link.download = `${name.replace(/[^\w.-]+/g, '-')}-zion-files.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function manifestName() {
  const meta = state.source.manifest.meta || {};
  return meta.name >= 0 ? state.source.s(meta.name) : '';
}

function card(title, colour, count) {
  const node = document.createElement('div');
  node.className = 'health-card';
  const heading = document.createElement('h3');
  const chip = document.createElement('span');
  chip.className = 'chip';
  chip.style.background = hexColour(colour);
  heading.append(chip, document.createTextNode(title));
  if (count !== undefined) {
    const badge = document.createElement('span');
    badge.className = 'count';
    badge.textContent = String(count);
    heading.append(badge);
  }
  node.append(heading);
  return node;
}

/** What changed since the baseline: the trend line an architect tracks over months. */
function renderDeltaCard(manifest) {
  const delta = manifest.delta;
  if (!delta) return null;
  const node = card('Since the baseline', DELTA_COLOURS.added, delta.added.length + delta.grown.length + delta.shrunk.length);
  node.dataset.section = 'delta';
  const base = delta.baseline || {};
  const label = base.label >= 0 ? state.source.s(base.label) : base.head ? `build of ${base.head.slice(0, 7)}` : 'the previous build';
  const text = document.createElement('p');
  text.textContent =
    `Against ${label}: ${delta.added.length} added, ${delta.removedCount || 0} removed, ` +
    `${delta.grown.length} grown and ${delta.shrunk.length} shrunk by 10% or more.`;
  node.append(text);

  const rows = [
    ['hotspots', 'Hotspots'], ['cycles', 'Import cycles'], ['violations', 'Layering violations'],
    ['untested', 'Untested risk'], ['oversized', 'Oversized'], ['knowledge', 'Knowledge risk'],
    ['orphans', 'Possible dead code'], ['bugprone', 'Bug-prone'], ['defects', 'Defect-prone'], ['rising', 'Rising hotspots'],
    ['hubs', 'Hubs'], ['clones', 'Clone pairs'], ['hiddenCoupling', 'Hidden coupling'], ['codes', 'Code breaches'],
    ['debt', 'Debt markers'], ['zonePain', 'Folders in the zone of pain'], ['files', 'Files'], ['loc', 'Logical lines'],
  ];
  const table = document.createElement('table');
  table.className = 'delta-table';
  for (const [key, name] of rows) {
    // A baseline from before a signal existed has no number for it: leave the
    // row out rather than report the whole count as new.
    if (!(key in (delta.before || {}))) continue;
    const before = (delta.before || {})[key] || 0;
    const after = (delta.after || {})[key] || 0;
    const change = after - before;
    const tr = document.createElement('tr');
    // Worse is red for every signal row; for files and lines a change is only information.
    const neutral = key === 'files' || key === 'loc';
    tr.className = change === 0 ? 'same' : neutral ? 'info' : change > 0 ? 'worse' : 'better';
    tr.innerHTML = `<td>${name}</td><td class="num">${before.toLocaleString()}</td><td class="num">→ ${after.toLocaleString()}</td>` +
      `<td class="num">${change > 0 ? '+' : ''}${change.toLocaleString()}</td>`;
    table.append(tr);
  }
  node.append(table);

  const list = document.createElement('ol');
  const became = delta.became || {};
  for (const [signal, ids] of Object.entries(became)) {
    for (const id of (ids || []).slice(0, 6)) {
      const li = document.createElement('li');
      const item = healthItem(id);
      item.querySelector('.meta').textContent = `became ${signal}`;
      li.append(item);
      list.append(li);
    }
  }
  for (const [id, lines] of (delta.grown || []).slice(0, 5)) {
    const li = document.createElement('li');
    const item = healthItem(id);
    item.querySelector('.meta').textContent = `+${lines} ln`;
    li.append(item);
    list.append(li);
  }
  if (list.children.length) node.append(list);
  const hint = document.createElement('p');
  hint.className = 'health-empty';
  hint.textContent = 'Colour lens “changed since baseline” paints it on the map; filter is:added, is:grown, is:shrunk.';
  node.append(hint);
  return node;
}

/** The folder-level dependency picture: the heaviest edges, and every one that points the wrong way. */
function renderDependencyCard(manifest) {
  const deps = manifest.dependencies;
  if (!deps || !deps.matrix || !deps.matrix.length) return null;
  const node = card('Folder dependencies', LINK_COLOURS.out, deps.matrix.length);
  node.dataset.section = 'dependencies';
  const rules = deps.rules >= 0 ? state.source.s(deps.rules) : '';
  const text = document.createElement('p');
  text.textContent = rules && rules !== 'majority'
    ? `Imports between folders, heaviest first. Layering rules: ${rules}.`
    : 'Imports between folders, heaviest first. With no .zion/rules.json, an import is against the grain when the two folders import each other and this is the thinner direction.';
  node.append(text);
  const violating = new Set((deps.violatingPairs || []).map(([a, b]) => `${a}>${b}`));
  const name = (id) => {
    const d = manifest.districts[id];
    return d ? state.source.districtLabel(d) : `district ${id}`;
  };
  const list = document.createElement('ol');
  for (const [from, to, count] of deps.matrix.slice(0, 12)) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'health-item dep-item';
    button.dataset.district = String(from);
    if (violating.has(`${from}>${to}`)) button.classList.add('violating');
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${count} import${count === 1 ? '' : 's'}`;
    button.append(meta, document.createTextNode(`${name(from)} → ${name(to)}`));
    li.append(button);
    list.append(li);
  }
  node.append(list);
  if (deps.coupling && deps.coupling.length) {
    const sub = document.createElement('p');
    sub.className = 'health-empty';
    sub.textContent = 'Folders that change together: ' + deps.coupling.slice(0, 4)
      .map(([a, b, , commits]) => `${name(a)} ↔ ${name(b)} (${commits})`).join(' · ');
    node.append(sub);
  }
  return node;
}

/** A district button for a Health card: clicking it flies to that folder. */
function districtItem(manifest, id, metaText) {
  const d = manifest.districts[id];
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'health-item dep-item';
  button.dataset.district = String(id);
  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = metaText;
  button.append(meta, document.createTextNode(d ? state.source.districtLabel(d) : `district ${id}`));
  return button;
}

/**
 * Martin's main sequence: every folder with both axes known, drawn as a small
 * A/I scatter with the ideal line, and the folders far off it listed.
 */
function renderZonesCard(manifest) {
  const rows = manifest.mainSequence || [];
  if (!rows.length) return null;
  const off = rows.filter((r) => r[4]);
  const node = card('Main sequence', 0xc77dff, off.length);
  node.dataset.section = 'zones';
  const text = document.createElement('p');
  text.textContent =
    'Abstractness (share of abstract classes) against instability, per folder. On the diagonal is healthy. ' +
    'Bottom-left is the zone of pain: concrete code everything leans on. Top-right is the zone of uselessness: abstractions nothing uses.';
  node.append(text);
  node.append(mainSequencePlot(manifest, rows));
  const list = document.createElement('ol');
  for (const [id, a, i, dist, zone] of off.sort((x, y) => y[3] - x[3]).slice(0, 10)) {
    const li = document.createElement('li');
    li.append(districtItem(manifest, id, `${zone} · D ${dist.toFixed(2)}`));
    li.title = `A ${a.toFixed(2)}, I ${i.toFixed(2)}`;
    list.append(li);
  }
  if (list.children.length) node.append(list);
  else {
    const none = document.createElement('p');
    none.className = 'health-empty';
    none.textContent = 'No folder is far enough off the main sequence to call it a zone.';
    node.append(none);
  }
  return node;
}

/** The A/I plane as inline SVG: one dot per folder, sized by its buildings. */
function mainSequencePlot(manifest, rows, highlight = -1) {
  const NS = 'http://www.w3.org/2000/svg';
  const size = 150;
  const pad = 18;
  const span = size - pad * 2;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('class', 'main-sequence');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Abstractness against instability per folder');
  const el = (name, attrs, text) => {
    const node = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (text) node.textContent = text;
    svg.append(node);
    return node;
  };
  const px = (i) => pad + i * span;
  const py = (a) => pad + (1 - a) * span;
  el('rect', { x: pad, y: pad, width: span, height: span, class: 'ms-frame' });
  el('path', { d: `M${px(0)},${py(0)} L${px(0.5)},${py(0)} L${px(0)},${py(0.5)} Z`, class: 'ms-pain' });
  el('path', { d: `M${px(1)},${py(1)} L${px(0.5)},${py(1)} L${px(1)},${py(0.5)} Z`, class: 'ms-useless' });
  el('line', { x1: px(0), y1: py(1), x2: px(1), y2: py(0), class: 'ms-ideal' });
  el('text', { x: px(0.5), y: size - 3, 'text-anchor': 'middle', class: 'ms-axis' }, 'instability →');
  el('text', { x: 9, y: px(0.5), 'text-anchor': 'middle', class: 'ms-axis', transform: `rotate(-90 9 ${px(0.5)})` }, 'abstractness →');
  const most = Math.max(1, ...rows.map(([id]) => (manifest.districts[id] || {}).buildings || 1));
  for (const [id, a, i, , zone] of rows) {
    const d = manifest.districts[id];
    const r = 2 + 4 * Math.sqrt(((d && d.buildings) || 1) / most);
    const dot = el('circle', { cx: px(i), cy: py(a), r, class: `ms-dot${zone ? ` ms-${zone}` : ''}${id === highlight ? ' ms-here' : ''}` });
    const title = document.createElementNS(NS, 'title');
    title.textContent = `${d ? state.source.districtLabel(d) : id}: A ${a.toFixed(2)}, I ${i.toFixed(2)}`;
    dot.append(title);
  }
  return svg;
}

/** City Hall's harbour: the third-party packages the repository trades with. */
function renderHarbourCard(manifest) {
  const ext = manifest.externals;
  if (!ext || !ext.packages || !ext.packages.length) return null;
  const node = card('Harbour — external packages', 0x3f8fb0, ext.total);
  node.dataset.section = 'externals';
  const text = document.createElement('p');
  const manifests = (ext.manifests || []).map((m) => state.source.s(m)).filter(Boolean);
  text.textContent = manifests.length
    ? `Packages imported from outside the repository, most-used first. Declared in ${manifests.join(', ')}.`
    : 'Packages imported from outside the repository, most-used first. No requirements, pyproject or package.json was found to check them against.';
  node.append(text);
  const table = document.createElement('table');
  table.className = 'delta-table harbour-table';
  for (const [name, ecosystem, files, folders, declared] of ext.packages.slice(0, 12)) {
    const tr = document.createElement('tr');
    tr.className = !declared && manifests.length ? 'worse' : 'same';
    const td = (value, cls) => {
      const cell = document.createElement('td');
      if (cls) cell.className = cls;
      cell.textContent = value;
      tr.append(cell);
    };
    td(state.source.s(name) || '(locked)');
    td(ecosystem);
    td(`${files} file${files === 1 ? '' : 's'}`, 'num');
    td(`${folders} folder${folders === 1 ? '' : 's'}`, 'num');
    table.append(tr);
  }
  node.append(table);
  const add = (label, ids) => {
    if (!ids || !ids.length) return;
    const p = document.createElement('p');
    p.className = 'health-empty';
    p.textContent = `${label}: ${ids.map((i) => state.source.s(i)).join(', ')}`;
    node.append(p);
  };
  add('Imported but not declared', ext.undeclared);
  add('Declared but never imported', ext.unused);
  return node;
}

/** One tiny line per signal across the builds in this output directory. */
function renderCensusCard(manifest) {
  const census = manifest.census || [];
  if (census.length < 2) return null;
  const node = card('Census across builds', 0x9aa3ad, census.length);
  node.dataset.section = 'census';
  const text = document.createElement('p');
  text.textContent = `The last ${census.length} builds into this directory, oldest on the left. Rising is worse for every row but files and lines.`;
  node.append(text);
  const rows = [
    ['hotspots', 'Hotspots'], ['cycles', 'Cycles'], ['violations', 'Layering'], ['untested', 'Untested risk'],
    ['bugprone', 'Bug-prone'], ['debt', 'Debt markers'], ['codes', 'Code breaches'], ['zonePain', 'Zone of pain'],
    ['files', 'Files'], ['loc', 'Logical lines'],
  ];
  const table = document.createElement('table');
  table.className = 'delta-table census-table';
  for (const [key, label] of rows) {
    const values = census.map((e) => Number((e.totals || {})[key] || 0));
    if (!values.some((v) => v)) continue;
    const last = values[values.length - 1];
    const change = last - values[0];
    const tr = document.createElement('tr');
    const neutral = key === 'files' || key === 'loc';
    tr.className = change === 0 ? 'same' : neutral ? 'info' : change > 0 ? 'worse' : 'better';
    const name = document.createElement('td');
    name.textContent = label;
    const spark = document.createElement('td');
    spark.append(sparkline(values));
    const now = document.createElement('td');
    now.className = 'num';
    now.textContent = `${last.toLocaleString()} (${change > 0 ? '+' : ''}${change.toLocaleString()})`;
    tr.append(name, spark, now);
    table.append(tr);
  }
  node.append(table);
  return node;
}

function sparkline(values) {
  const NS = 'http://www.w3.org/2000/svg';
  const w = 90;
  const h = 18;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('class', 'sparkline');
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const x = (i) => (values.length === 1 ? w / 2 : (i / (values.length - 1)) * (w - 4) + 2);
  const y = (v) => (hi === lo ? h / 2 : h - 2 - ((v - lo) / (hi - lo)) * (h - 4));
  const line = document.createElementNS(NS, 'polyline');
  line.setAttribute('points', values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' '));
  svg.append(line);
  const dot = document.createElementNS(NS, 'circle');
  dot.setAttribute('cx', x(values.length - 1));
  dot.setAttribute('cy', y(values[values.length - 1]));
  dot.setAttribute('r', 1.8);
  svg.append(dot);
  return svg;
}

/** The reader's notes, with export/import so they can travel. */
function renderNotesCard() {
  const node = card('Your notes', 0xff5fa2, context.notes ? context.notes.all().length : 0);
  node.dataset.section = 'notes';
  const notes = context.notes;
  const text = document.createElement('p');
  if (!notes || !notes.available) {
    text.textContent = 'Notes need browser storage, which is unavailable here.';
    node.append(text);
    return node;
  }
  text.textContent = 'Pinned in this browser. Add one from a building’s inspector; a pink pin marks it on the map.';
  node.append(text);
  const byPath = new Map();
  const col = columnIndex(state.source.manifest.indexColumns);
  for (const row of context.facetIndex || []) byPath.set(state.source.s(row[col.path]), row[col.id]);
  const list = document.createElement('ol');
  for (const item of notes.all().slice(0, 30)) {
    const id = byPath.get(item.path);
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'health-item';
    if (id !== undefined) button.dataset.building = String(id);
    else button.disabled = true;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = id === undefined ? 'not in this build' : '';
    button.append(meta, document.createTextNode(item.path));
    const body = document.createElement('span');
    body.className = 'note-text';
    body.textContent = item.text;
    button.append(body);
    li.append(button);
    list.append(li);
  }
  if (list.children.length) node.append(list);
  const actions = document.createElement('div');
  actions.className = 'g-actions';
  const exportButton = document.createElement('button');
  exportButton.type = 'button';
  exportButton.className = 'chip-btn';
  exportButton.textContent = 'Export';
  exportButton.addEventListener('click', () => {
    const blob = new Blob([notes.exportJson()], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'zion-notes.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  });
  const importButton = document.createElement('button');
  importButton.type = 'button';
  importButton.className = 'chip-btn';
  importButton.textContent = 'Import…';
  importButton.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      try {
        notes.importJson(await file.text());
      } catch (error) {
        text.textContent = `Could not import: ${error.message}`;
      }
    });
    input.click();
  });
  actions.append(exportButton, importButton);
  node.append(actions);
  return node;
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
  // The territory pickers belong to both lens controls; show and align them here,
  // where the lens is read, so the City Guide and the Filter tab never disagree.
  syncAuthorSelects();
  const item = (colour, label, count) => {
    const span = document.createElement('span');
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.style.background = typeof colour === 'string' ? colour : hexColour(colour);
    span.append(chip, document.createTextNode(count === undefined ? label : `${label} · ${count.toLocaleString()}`));
    key.append(span);
  };
  // Counts are over the buildings on screen: the key says how much of what
  // you are looking at falls in each band, not a legend in the abstract.
  const resident = context.resident || [];
  if (lens.value === 'health') {
    const names = { hotspot: 'hotspot', defect: 'defect-prone', bugprone: 'bug-prone', cycle: 'import cycle', violation: 'layering violation', hub: 'hub', oversized: 'oversized', codes: 'breaks a building code', knowledge: 'owner gone', orphan: 'orphan', healthy: 'nothing flagged' };
    const flags = state.source.manifest.flags || {};
    const counts = {};
    for (const b of resident) {
      const signal = healthSignal(b, flags);
      counts[signal] = (counts[signal] || 0) + 1;
    }
    for (const [signal, colour] of Object.entries(HEALTH_COLOURS)) {
      if (names[signal]) item(colour, names[signal], counts[signal] || 0);
    }
  } else if (LENS_BANDS[lens.value]) {
    const counts = new Map();
    for (const b of resident) {
      const band = lensBand(lens.value, b);
      counts.set(band, (counts.get(band) || 0) + 1);
    }
    for (const band of LENS_BANDS[lens.value]) item(band.colour, band.label, counts.get(band) || 0);
  } else if (lens.value === 'language' || lens.value === 'author') {
    // Categories: the most common ones on screen, then everything else.
    const counts = new Map();
    const authorTint = Boolean(state.source.manifest.flags && state.source.manifest.flags.authorship);
    for (const b of resident) {
      const name = lens.value === 'language'
        ? state.source.s(b.language) || 'unknown'
        : (authorTint ? state.source.s(b.author) : '') || 'unknown';
      counts.set(name, (counts.get(name) || 0) + 1);
    }
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    for (const [name, count] of ranked.slice(0, 10)) {
      item(name === 'unknown' ? 0x777777 : categoryColour(name, lens.value === 'language' ? undefined : null), name, count);
    }
    const rest = ranked.slice(10).reduce((sum, [, count]) => sum + count, 0);
    if (rest) item(0x555a63, `${ranked.length - 10} more`, rest);
  } else if (lens.value === 'archetype') {
    const counts = new Map();
    for (const b of resident) counts.set(b.archetype, (counts.get(b.archetype) || 0) + 1);
    for (const [name, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      item(ARCHETYPE_COLORS[name] || 0x777777, archetypeLabel(name), count);
    }
  } else if (lens.value === 'mainsequence') {
    const counts = new Map();
    for (const b of resident) {
      const band = mainSequenceBand(state.source.manifest.districts[b.district]);
      counts.set(band, (counts.get(band) || 0) + 1);
    }
    for (const band of MAIN_SEQUENCE_BANDS) item(band.colour, band.label, counts.get(band) || 0);
  } else if (lens.value === 'heat') {
    item('linear-gradient(90deg,#4b5563,#ff4d2e)', 'stable → hottest, by recent decay-weighted churn');
  } else if (lens.value === 'downtown') {
    item('linear-gradient(90deg,#2a2c31,#8fd6ff)', 'peripheral → most central');
  } else if (lens.value === 'era') {
    item(0x8a5a44, 'oldest third');
    item(0x8f97a3, 'middle third');
    item(0xbfe3ef, 'newest third');
  } else if (lens.value === 'territory') {
    const who = state.territoryAuthor || 'nobody selected';
    item('linear-gradient(90deg,#26282d,#ffc24a)', `share of the lines written by ${who}`);
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
      weight: region.logicalLoc || region.buildings || 0,
      grade: region.grade || '',
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
      weight: district.logicalLoc || 0,
      grade: district.grade || '',
    });
  }
  if (!context.labels) context.labels = new MapLabels(container, camera);
  const bounds = manifest.bounds;
  context.labels.setItems(items, Math.max(bounds[2], bounds[3]));
}

/** The go-to palette (palette.js): every file and folder, repository-wide. */
function setupPalette() {
  const root = document.getElementById('palette');
  if (!root) return;
  context.palette = new GoToPalette(root, {
    locked: () => state.source.locked,
    candidates: () => {
      const manifest = state.source.manifest;
      const items = [];
      for (const district of manifest.districts) {
        const label = state.source.locked
          ? state.source.districtLabel(district)
          : state.source.s(district.key) || state.source.districtLabel(district);
        items.push({
          kind: 'district', id: district.id, text: `${label}/`,
          hint: `${district.buildings} files${district.grade ? ` · grade ${district.grade}` : ''}`,
        });
      }
      if (!state.source.locked && context.facetIndex) {
        const col = columnIndex(manifest.indexColumns);
        for (const row of context.facetIndex) {
          const path = state.source.s(row[col.path]);
          if (path) items.push({ kind: 'building', id: row[col.id], text: path, hint: `${(row[col.loc] || 0).toLocaleString()} lines` });
        }
      }
      return items;
    },
    pick: (item) => {
      if (item.kind === 'district') {
        const district = state.source.manifest.districts[item.id];
        if (!district) return;
        teleportTo({ kind: 'district', district });
        context.inspector.showDistrict(district);
      } else {
        flyToBuilding(item.id);
      }
    },
  });
}

/** The plan view's folder arrows (selection.js::PlanFlows). */
function setupPlanFlows() {
  if (!context.planFlows) context.planFlows = new PlanFlows(THREE, scene);
  context.planFlows.build(state.source.manifest, districtCentre);
  context.planFlows.setLayerVisible('plan-flows', !state.hiddenLayers.has('plan_flows'));
}

/** The minimap (minimap.js): the viewer's side of its contract. */
function setupMiniMap() {
  const root = document.getElementById('minimap');
  if (!root) return;
  const colour = new THREE.Color();
  const lensSelect = document.getElementById('lens-select');
  const planButton = document.getElementById('plan-toggle');
  if (planButton) planButton.addEventListener('click', togglePlan);
  context.minimap = new MiniMap(root, {
    THREE,
    camera,
    manifest: state.source.manifest,
    buildings: () => context.resident,
    colourOf: (building) => {
      const lens = lensSelect ? lensSelect.value : 'archetype';
      return lensColour(THREE, state.source, lens, building, building.archetype || 'warehouse', state.territoryAuthor, colour).clone();
    },
    matches: () => state.filterMatches || null,
    positionOf,
    selection: () => (context.inspector && context.inspector.selected) || null,
    notedIds: () => pinnedIds(),
    districtLabel: (district) => state.source.districtLabel(district),
    mode: () => state.mode,
    visibleRect: () => context.top.visibleRect(),
    gradesShown: () => !state.hiddenLayers.has('grades'),
    flows: () => (state.mode === 'top' && context.planFlows && context.planFlows.layerOn ? context.planFlows.flows : []),
    navigate: miniMapNavigate,
  });
}

/**
 * Where a minimap gesture takes the camera. A click flies there; a drag scrubs,
 * moving the view immediately so the city slides under the cursor; a
 * Shift-click on a folder frames that folder.
 */
function miniMapNavigate(x, z, how) {
  if (state.mode === 'interior') return;
  if (how && how.district) {
    teleportTo({ kind: 'district', district: how.district });
    return;
  }
  const district = context.minimap && context.minimap.districtAt({ x, z });
  const h = district ? district.skyline.maxHeight : 12;
  if (how !== 'scrub') {
    teleportTo({ kind: 'point', x, z, h });
    return;
  }
  context.flight.active = false;
  if (state.mode === 'top') {
    context.top.centreOn(x, z);
  } else if (state.mode === 'orbit') {
    context.orbit.spinning = false;
    context.orbit.target.set(x, 0, z);
    context.orbit._clampTarget();
    context.orbit.apply();
  } else {
    if (state.mode !== 'fly') setMode('fly');
    // Keep altitude and heading; slide so the point on the ground the camera
    // looks at is the one under the cursor.
    const fly = context.fly;
    const cosPitch = Math.cos(fly.pitch);
    const dir = { x: -Math.sin(fly.yaw) * cosPitch, y: Math.sin(fly.pitch), z: -Math.cos(fly.yaw) * cosPitch };
    const bounds = state.source.manifest.bounds;
    const span = Math.max(bounds[2], bounds[3]);
    const reach = dir.y < -0.05 ? Math.min(span * 0.6, fly.position.y / -dir.y) : 0;
    fly.position.x = x - dir.x * reach;
    fly.position.z = z - dir.z * reach;
    fly.velocity.set(0, 0, 0);
    fly.clamp();
    fly.apply();
  }
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
  if (item.dataset.district !== undefined) {
    const district = state.source.manifest.districts[Number(item.dataset.district)];
    if (district) {
      teleportTo({ kind: 'district', district });
      context.inspector.showDistrict(district);
    }
    return;
  }
  if (item.dataset.building !== undefined) flyToBuilding(Number(item.dataset.building));
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

/**
 * The tour's key hints live inside the tour panel: the floating prompt sits
 * at a fixed height and covered the panel's header (and its Pause button).
 */
function setTourPrompt() {
  const tour = context.tour;
  setPrompt('');
  const hint = document.getElementById('tour-hint');
  if (!tour || !tour.running) {
    hint.innerHTML = '';
  } else if (tour.paused) {
    hint.innerHTML = 'Paused &nbsp;·&nbsp; <kbd>K</kbd> or <b>Resume</b> to carry on &nbsp;·&nbsp; <kbd>Esc</kbd> to end';
  } else {
    hint.innerHTML = '<kbd>K</kbd> pause &nbsp;·&nbsp; <kbd>T</kbd> or <kbd>Esc</kbd> to end &nbsp;·&nbsp; any movement key takes over';
  }
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

/** The colour lens in the Filter tab; "archetype" before the guide exists. */
function currentLens() {
  const lens = document.getElementById('lens-select');
  return lens ? lens.value : 'archetype';
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
    // Material colours only under the archetype lens, from the very first frame.
    multicolour: currentLens() === 'archetype',
    notes: pinnedIds(),
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
  // A rebuild (streaming, LOD, a switch) must not silently drop the lens --
  // or the History slider's date.
  mesh.territoryAuthor = state.territoryAuthor;
  const lens = document.getElementById('lens-select');
  if (lens && lens.value !== 'archetype') mesh.recolour(lens.value);
  if (state.timeline !== null) mesh.setTimeline(state.timeline, { burn: historySpan() >= 45 });
  applyHiddenLayers();
  hover.target = null;
  if (context.hoverOutline) context.hoverOutline.visible = false;

  if (context.minimap) context.minimap.invalidate();
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

/** A query compiled with everything the richer tokens need (edges, districts). */
function compileQuery(text) {
  const manifest = state.source.manifest;
  return parseQuery(text, manifest.indexColumns, (idx) => state.source.s(idx), resolveExt, {
    edges: context.edges,
    rows: context.facetIndex,
    resolveDistrict: (id) => {
      const district = manifest.districts[id];
      return district ? state.source.s(district.key) : '';
    },
    districtZone: (id) => (manifest.districts[id] && manifest.districts[id].zone) || '',
  });
}

/** Re-run the current filter text against the resident set. Called after any
 *  streaming rebuild, since a fresh CityMesh has no ghosting of its own.
 *
 *  A focused folder (a selected district or region, S14) narrows the result
 *  further: everything outside it fades exactly as a non-match does, so the
 *  folder stands out without leaving the city. */
function applyActiveFilter() {
  if (!context.city || !context.facetIndex) return;
  const text = state.filterText || '';
  const predicate = compileQuery(text);
  const summary = document.getElementById('filter-summary');
  const focus = state.focus;
  if (context.minimap) context.minimap.invalidate();
  if (!predicate && !focus) {
    state.filterMatches = null;
    context.city.clearFilter();
    if (summary) summary.textContent = 'every building shown';
    return;
  }
  const districtCol = columnIndex(state.source.manifest.indexColumns).district;
  const scoped = focus
    ? (row) => focus.has(row[districtCol]) && (!predicate || predicate(row))
    : predicate;
  const result = runQuery(context.facetIndex, scoped, state.source.manifest.indexColumns);
  state.filterMatches = result.ids;
  context.city.applyFilter(result.ids);
  if (summary) {
    summary.textContent =
      `${result.count.toLocaleString()} files · ${result.loc.toLocaleString()} lines ` +
      `· in ${result.districts} district${result.districts === 1 ? '' : 's'}` +
      (focus ? ' · inside the selected folder' : '');
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
      applyLens(event.target.value);
      rememberLens(event.target.value);
    });
  }
  // The territory lens paints one author; the list is the manifest's own
  // author table, so a locked city offers no names until it is unlocked.
  for (const select of authorSelects()) {
    select.addEventListener('change', (event) => {
      state.territoryAuthor = event.target.value;
      syncAuthorSelects();
      applyLens('territory');
    });
  }
  fillAuthorSelect();
}

/** The two territory pickers: the Filter tab's, and the City Guide's copy. */
function authorSelects() {
  return ['lens-author', 'guide-lens-author']
    .map((id) => document.getElementById(id))
    .filter(Boolean);
}

/**
 * Both pickers are one control: same options, same value, shown only while the
 * territory lens is the one in force. Without this the City Guide could pick
 * "one author's territory" and had no way to say *whose*, so it always painted
 * whoever happened to be first in the table.
 */
function syncAuthorSelects() {
  const lens = document.getElementById('lens-select');
  const on = Boolean(lens) && lens.value === 'territory';
  for (const select of authorSelects()) {
    select.hidden = !on;
    if (select.value !== state.territoryAuthor) select.value = state.territoryAuthor;
  }
}

function fillAuthorSelect() {
  const selects = authorSelects();
  if (!selects.length) return;
  const authors = (state.source.manifest.stats && state.source.manifest.stats.authors) || [];
  const options = [];
  for (const row of authors.slice(0, 60)) {
    const name = state.source.s(row.name);
    if (!name) continue;
    options.push({ value: name, label: `${name} (${row.lines.toLocaleString()} lines)` });
  }
  for (const select of selects) {
    select.innerHTML = '';
    for (const option of options) {
      const el = document.createElement('option');
      el.value = option.value;
      el.textContent = option.label;
      select.append(el);
    }
  }
  if (!state.territoryAuthor && options.length) state.territoryAuthor = options[0].value;
  syncAuthorSelects();
}

/** The City Guide's copy of the lens key, so the colours explain themselves where they are chosen. */
function mirrorLensKey() {
  const key = document.getElementById('lens-key');
  const guideKey = document.getElementById('guide-lens-key');
  if (!key || !guideKey) return;
  guideKey.replaceChildren(...[...key.childNodes].map((node) => node.cloneNode(true)));
}

const LENS_STORAGE = 'zion.lens';

/** The lens a fresh page opens with: the reader's last choice, else language. */
function initialLens() {
  if (state.selftest) return 'archetype';
  try {
    const saved = localStorage.getItem(LENS_STORAGE);
    if (saved && document.querySelector(`#lens-select option[value="${saved}"]`)) return saved;
  } catch {
    // Storage can be blocked; the default still applies.
  }
  return 'language';
}

function rememberLens(value) {
  if (state.selftest) return;
  try {
    localStorage.setItem(LENS_STORAGE, value);
  } catch {
    /* not remembered, which is fine */
  }
}

/** The City Guide's "Colour buildings by": the same options as the Filter tab's lens. */
function setupGuideColour() {
  const lens = document.getElementById('lens-select');
  const guide = document.getElementById('guide-lens');
  if (!lens || !guide) return;
  guide.innerHTML = lens.innerHTML.replace(/>colour: /g, '>');
  guide.value = lens.value;
  guide.addEventListener('change', (event) => {
    applyLens(event.target.value);
    rememberLens(event.target.value);
  });
  guide.addEventListener('keydown', (event) => event.stopPropagation());
  // Arrow keys on the author picker must not reach the global handler either.
  const author = document.getElementById('guide-lens-author');
  if (author) author.addEventListener('keydown', (event) => event.stopPropagation());
}

/** Switch the colour lens, keeping the select, the key and the city in step. */
function applyLens(value) {
  const lens = document.getElementById('lens-select');
  if (lens && lens.value !== value) lens.value = value;
  const guide = document.getElementById('guide-lens');
  if (guide && guide.value !== value) guide.value = value;
  if (context.city) {
    context.city.territoryAuthor = state.territoryAuthor;
    context.city.recolour(value);
  }
  if (context.minimap) context.minimap.invalidate();
  renderLensKey();
  mirrorLensKey();
}

// ---------------------------------------------------------------------------
// Selection: what the selected thing is connected to (selection.js), and the
// focus fade for a selected folder (S14).
// ---------------------------------------------------------------------------

function buildingById(id) {
  if (!context._residentById || context._residentById.size !== context.resident.length) {
    context._residentById = new Map(context.resident.map((b) => [b.id, b]));
  }
  return context._residentById.get(id);
}

/** Ground point of a building, or of its district's centre when not resident. */
function positionOf(id) {
  const manifest = state.source.manifest;
  const building = buildingById(id);
  if (building) {
    const district = manifest.districts[building.district];
    return {
      x: (building.x || 0) + (building.width || 4) / 2,
      z: (building.y || 0) + (building.depth || 4) / 2,
      y: plinthTop(district ? district.level : 0),
      width: building.width,
      depth: building.depth,
      height: building.height,
    };
  }
  const row = indexRowById().get(id);
  if (!row) return null;
  const district = manifest.districts[row[columnIndex(manifest.indexColumns).district]];
  return district ? { ...districtCentre(district), approximate: true } : null;
}

function districtCentre(district) {
  if (!district) return null;
  const [x, z, w, h] = district.rect;
  return { x: x + w / 2, z: z + h / 2, y: plinthTop(district.level) + 1 };
}

let selectionToken = 0;

async function updateSelection(selection) {
  const token = ++selectionToken;
  const overlay = context.overlay;
  const manifest = state.source.manifest;
  const previousFocus = state.focus;
  state.focus = null;
  if (!selection) {
    if (overlay) overlay.clear();
  } else if (selection.kind === 'building') {
    const b = selection.building;
    const edges = context.edges;
    const outgoing = edges ? (edges.imports.get(b.id) || []).map((to) => [to, edges.violating.has(`${b.id}>${to}`)]) : [];
    const incoming = edges ? (edges.importers.get(b.id) || []).map((from) => [from, edges.violating.has(`${from}>${b.id}`)]) : [];
    let partners = [];
    if (manifest.flags && manifest.flags.coupling) {
      try {
        const bridges = await state.source.bridges();
        if (token !== selectionToken) return;
        partners = bridges.filter(([x, y]) => x === b.id || y === b.id).map(([x, y, n]) => [x === b.id ? y : x, n]);
      } catch (error) {
        partners = [];
      }
    }
    // Tests are not dependents (the analyzer's impact count leaves them out too).
    const testBit = 1 << 0;
    const flagsCol = columnIndex(manifest.indexColumns).flags;
    const rows = indexRowById();
    const impact = edges
      ? blastRadius(edges.importers, b.id).filter(([id]) => {
          const row = rows.get(id);
          return !row || !(row[flagsCol] & testBit);
        })
      : [];
    if (overlay) {
      overlay.showBuilding(b, {
        outgoing, incoming, partners, impact, positionOf,
        hidden: b.hiddenCoupling || [],
        clones: b.cloneOf || [],
      });
    }
  } else if (selection.kind === 'district') {
    const d = selection.district;
    const deps = manifest.dependencies;
    const links = [];
    if (deps) {
      const violating = new Set((deps.violatingPairs || []).map(([a, c]) => `${a}>${c}`));
      for (const [from, to, count] of deps.matrix || []) {
        if (from === d.id) links.push({ district: manifest.districts[to], kind: 'out', weight: count, violates: violating.has(`${from}>${to}`) });
        else if (to === d.id) links.push({ district: manifest.districts[from], kind: 'in', weight: count, violates: violating.has(`${from}>${to}`) });
      }
      const heaviestImport = Math.max(1, ...links.map((l) => l.weight));
      const coupling = (deps.coupling || []).filter(([a, c]) => a === d.id || c === d.id);
      const heaviestCommits = Math.max(1, ...coupling.map((row) => row[3]));
      for (const [a, c, , commits] of coupling) {
        // Scaled onto the import weights, so the thickest co-change arc and
        // the thickest import arc are comparable on screen.
        links.push({ district: manifest.districts[a === d.id ? c : a], kind: 'cochange', weight: (commits / heaviestCommits) * heaviestImport });
      }
    }
    if (overlay) overlay.showDistrict(d, { links: links.filter((l) => l.district), centreOf: districtCentre });
    state.focus = new Set([d.id]);
  } else if (selection.kind === 'region') {
    if (overlay) overlay.clear();
    state.focus = new Set(selection.districtIds || []);
  }
  if (previousFocus || state.focus) applyActiveFilter();
}

/** Building ids that carry one of the reader's notes. */
function pinnedIds() {
  const notes = context.notes;
  if (!notes || !notes.available || state.source.locked || !context.facetIndex) return null;
  const paths = new Set(notes.all().map((n) => n.path));
  if (!paths.size) return null;
  const col = columnIndex(state.source.manifest.indexColumns);
  const ids = new Set();
  for (const row of context.facetIndex) if (paths.has(state.source.s(row[col.path]))) ids.add(row[col.id]);
  return ids;
}

// ---------------------------------------------------------------------------
// History slider (S7): the city as it stood on a past day.
// ---------------------------------------------------------------------------

function historySpan() {
  const meta = state.source.manifest.meta || {};
  const flags = state.source.manifest.flags || {};
  return flags.age ? Math.max(0, meta.historyDays || 0) : 0;
}

function historyDate(daysBefore) {
  const meta = state.source.manifest.meta || {};
  if (!meta.headTs) return `${Math.round(daysBefore)} days before the newest commit`;
  return new Date((meta.headTs - daysBefore * 86400) * 1000).toISOString().slice(0, 10);
}

/** `null` returns to the present; otherwise days before the newest commit. */
function setTimeline(daysBefore) {
  const span = historySpan();
  state.timeline = daysBefore === null || daysBefore === undefined || !span ? null : Math.max(0, Math.min(span, daysBefore));
  const slider = document.getElementById('history');
  const out = document.getElementById('history-out');
  if (slider) slider.value = String(state.timeline === null ? span : span - state.timeline);
  let born = null;
  if (context.city) {
    // Monthly buckets say nothing about a history shorter than a month or two.
    born = context.city.setTimeline(state.timeline, { burn: span >= 45 });
    if (state.timeline === null) applyHiddenLayers();
  }
  if (out) {
    out.textContent = state.timeline === null
      ? 'today'
      : `${historyDate(state.timeline)}${born !== null ? ` · ${born.toLocaleString()} files` : ''}`;
  }
  document.body.classList.toggle('history-active', state.timeline !== null);
}

let historyPlayback = null;

function toggleHistoryPlayback() {
  const button = document.getElementById('history-play');
  if (historyPlayback) {
    cancelAnimationFrame(historyPlayback.frame);
    historyPlayback = null;
    if (button) button.textContent = '▶';
    return;
  }
  const span = historySpan();
  if (!span) return;
  // Twelve seconds for the whole history, however long it is.
  const started = performance.now();
  const duration = 12000;
  const step = (now) => {
    const t = Math.min(1, (now - started) / duration);
    setTimeline(span * (1 - t));
    if (t >= 1) {
      historyPlayback = null;
      if (button) button.textContent = '▶';
      setTimeline(null);
      return;
    }
    historyPlayback.frame = requestAnimationFrame(step);
  };
  historyPlayback = { frame: requestAnimationFrame(step) };
  if (button) button.textContent = '❚❚';
}

function setupHistory() {
  const control = document.getElementById('history-control');
  const slider = document.getElementById('history');
  const span = historySpan();
  if (!control || !slider) return;
  control.hidden = !span;
  if (!span) return;
  slider.min = '0';
  slider.max = String(span);
  slider.step = String(Math.max(0.5, span / 400));
  slider.value = String(span);
  slider.addEventListener('input', () => {
    const value = Number(slider.value);
    setTimeline(value >= span ? null : span - value);
  });
  const play = document.getElementById('history-play');
  if (play) play.addEventListener('click', toggleHistoryPlayback);
  setTimeline(null);
}

// ---------------------------------------------------------------------------
// Saved views (views.js): the view on screen as a link.
// ---------------------------------------------------------------------------

function currentView() {
  const selected = context.inspector && context.inspector.selected;
  const selection = selected && selected.kind === 'building'
    ? { kind: 'building', id: selected.building.id }
    : selected && selected.kind === 'district'
      ? { kind: 'district', id: selected.district.id }
      : null;
  const lens = document.getElementById('lens-select');
  return captureView({
    position: camera.position,
    yaw: context.fly.yaw,
    pitch: context.fly.pitch,
    filter: state.filterText,
    lens: lens ? lens.value : 'archetype',
    author: lens && lens.value === 'territory' ? state.territoryAuthor : '',
    selection,
    timeline: state.timeline,
    mode: state.mode,
  });
}

async function applyView(view) {
  if (!view) return false;
  setMode('fly');
  context.fly.position.set(view.position.x, view.position.y, view.position.z);
  context.fly.yaw = view.yaw;
  context.fly.pitch = view.pitch;
  context.fly.apply();
  if (view.mode === 'top') {
    setMode('top');
    // A plan link reopens on exactly the ground it showed, with no glide.
    context.flight.active = false;
    context.top.target.set(view.position.x, 0, view.position.z);
    context.top.height = view.position.y;
    context.top._clamp();
    context.top.apply();
  }
  state.filterText = view.filter || '';
  const input = document.getElementById('filter-input');
  if (input) input.value = state.filterText;
  if (view.author) {
    state.territoryAuthor = view.author;
    const select = document.getElementById('lens-author');
    if (select) select.value = view.author;
  }
  lodRebuiltAt = -Infinity;
  await refreshResident(true);
  applyLens(view.lens || 'archetype');
  setTimeline(view.timeline);
  applyActiveFilter();
  if (view.selection && view.selection.kind === 'district') {
    const district = state.source.manifest.districts[view.selection.id];
    if (district) context.inspector.showDistrict(district);
  } else if (view.selection) {
    const building = buildingById(view.selection.id);
    if (building) context.inspector.showBuilding(building);
  }
  return true;
}

function setupViewLinks() {
  const button = document.getElementById('view-link');
  if (button) {
    button.addEventListener('click', async () => {
      const hash = viewToHash(currentView());
      history.replaceState(null, '', `${location.pathname}${location.search}${hash}`);
      const copied = await copyText(location.href);
      const label = button.textContent;
      button.textContent = copied ? 'Link copied' : 'Link ready';
      setTimeout(() => { button.textContent = label; }, 1600);
    });
  }
  window.addEventListener('hashchange', () => applyView(viewFromHash(location.hash)));
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
  if (target.kind === 'district' || target.kind === 'region') {
    // A folder is not outlined by the per-building box: hovering it highlights
    // the whole neighbourhood instead, and a box round a region would claim a
    // footprint it does not have.
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
  // Anything that is not a building has already returned above; this guard is
  // for the next target kind someone adds, so an unhandled one hides the
  // outline instead of throwing on `building.x` and taking the whole viewer
  // down with it.
  if (!building) {
    outline.visible = false;
    return;
  }
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
  } else if (state.mode === 'top') {
    // A plan is a map: dragging slides the paper, it never tilts the view.
    context.top.panDelta(dx, dy, window.innerHeight);
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
  } else if (state.mode === 'top') {
    context.flight.active = false;
    context.top.zoomBy(-notches);
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
  if (previous === 'top' && mode !== 'top') {
    // Leave the plan from exactly where it is, looking down, so nothing jumps.
    context.flight.active = false;
    context.top.handOff(context.fly);
  }
  state.mode = mode;
  context.fly.enabled = mode === 'fly';
  context.orbit.active = mode === 'orbit';
  context.walk.enabled = mode === 'walk';
  context.top.active = mode === 'top';
  syncPlanButton();
  if (mode === 'top' && previous !== 'top') {
    if (previous === 'orbit') context.orbit.handOff(context.fly);
    document.exitPointerLock?.();
    // Centre the plan on what the camera was looking at, then rise into it.
    context.top.adopt(context.fly);
    const pose = context.top.pose();
    context.flight.startPose(camera.position.clone(), camera.quaternion.clone(), pose.position, pose.quaternion, 1.1);
    setPlanPrompt();
    return;
  }
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

/**
 * The plan view looks through a longer lens than flight does; ease between the
 * two so entering or leaving the map is a zoom, not a cut.
 */
function easeFov(dt) {
  // Fog is tuned for a camera among the buildings; from the plan's height it
  // would wash the whole map out. Push it back by the altitude while the plan
  // is up, and restore it exactly afterwards.
  const fog = scene.fog;
  if (fog) {
    if (!fog.userData) fog.userData = {};
    if (fog.userData.near === undefined) fog.userData = { near: fog.near, far: fog.far };
    const lift = state.mode === 'top' ? camera.position.y : 0;
    fog.near = fog.userData.near + lift;
    fog.far = fog.userData.far + lift;
  }
  const manifestFov = state.source.manifest && state.source.manifest.camera ? state.source.manifest.camera.fov : 60;
  const want = state.mode === 'top' ? context.top.fov : manifestFov;
  if (Math.abs(camera.fov - want) < 0.01) return;
  camera.fov = Math.abs(camera.fov - want) < 0.05 ? want : camera.fov + (want - camera.fov) * Math.min(1, dt * 5);
  camera.updateProjectionMatrix();
}

function setPlanPrompt() {
  if (state.mode !== 'top') return;
  setPrompt('Plan view &nbsp;·&nbsp; drag or <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> to pan, wheel or <kbd>Q</kbd><kbd>E</kbd> to zoom &nbsp;·&nbsp; <kbd>R</kbd> whole city &nbsp;·&nbsp; <kbd>P</kbd> to fly from here');
}

function syncPlanButton() {
  const button = document.getElementById('plan-toggle');
  if (button) button.setAttribute('aria-pressed', String(state.mode === 'top'));
}

function togglePlan() {
  setMode(state.mode === 'top' ? 'fly' : 'top');
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
  } else if (target.kind === 'point') {
    point = { x: target.x, z: target.z, h: target.h || 12, size: target.size };
  } else {
    const [x, z, w, h] = target.district.rect;
    point = { x: x + w / 2, z: z + h / 2, h: target.district.skyline.maxHeight, size: Math.max(w, h) };
  }
  context.cityHall.hide();
  document.body.classList.remove('hall-open');
  if (state.mode === 'top') {
    // Stay on the map: glide the plan over the place instead of dropping out
    // of it. A district is framed whole; a file or a point keeps the zoom
    // unless it is too far out to pick the building out.
    const top = context.top;
    top.target.x = point.x;
    top.target.z = point.z;
    if (point.size) top.height = point.size * 1.5;
    else if (target.kind === 'building') top.height = Math.min(top.height, span * 0.3);
    top._clamp();
    const pose = top.pose();
    context.flight.startPose(camera.position.clone(), camera.quaternion.clone(), pose.position, pose.quaternion, 0.9);
    return;
  }
  setMode('fly');
  context.flight.start(
    camera.position.clone(),
    camera.quaternion.clone(),
    new THREE.Vector3(point.x - span * 0.15, Math.max(34, point.h * 1.7 + 20), point.z + span * 0.15),
    new THREE.Vector3(point.x, point.h * 0.4, point.z),
    1.3
  );
}

/**
 * A flight moves the camera directly and then stops, but it never touches the
 * controller the next frame falls back to. In fly mode that controller still
 * holds the pose the flight started from, so its very next `apply()` yanks the
 * view home the moment the flight lands. Hand the arrived pose back to it.
 */
function adoptFlightArrival() {
  if (state.mode !== 'fly') return;
  const fly = context.fly;
  fly.position.copy(camera.position);
  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
  fly.yaw = Math.atan2(-forward.x, -forward.z);
  fly.pitch = Math.asin(Math.max(-1, Math.min(1, forward.y)));
  fly.velocity.set(0, 0, 0);
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
  // Go to anything: Ctrl/Cmd+K from anywhere, or / when not typing.
  const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
  if (context.palette && ((event.ctrlKey || event.metaKey) && event.code === 'KeyK' || (!typing && event.key === '/'))) {
    event.preventDefault();
    if (context.palette.isOpen) context.palette.close();
    else context.palette.open();
    return;
  }
  if (typing) return;

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
    case 'KeyP':
      togglePlan();
      break;
    case 'KeyM':
      if (context.minimap) context.minimap.toggle();
      break;
    case 'KeyR':
      // Re-frame the whole plan without leaving the orbit (or the map).
      if (state.mode === 'orbit') {
        context.orbit.frame(state.source.manifest.bounds);
        setOrbitPrompt();
      } else if (state.mode === 'top') {
        context.flight.active = false;
        context.top.frame();
      }
      break;
    case 'KeyN':
      context.tour.skipToNext();
      break;
    case 'KeyK':
      if (context.tour.togglePause()) setTourPrompt();
      break;
    case 'KeyT':
      // The tour flies its own oblique route; it cannot run on a map.
      if (state.mode === 'top') setMode('fly');
      context.tour.start();
      setTourPrompt();
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
      // In the plan, E is zoom (TopCamera reads it), not "enter".
      if (state.mode !== 'top') await handleEnter();
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
  // Notes are keyed by the repository's name and each file's path, both of
  // which only exist once the labels do.
  setupNotes();
  fillAuthorSelect();
  renderGuide();
  setupMapLabels();
  if (context.minimap) context.minimap.invalidate();
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
      if (context.flight.update(dt)) adoptFlightArrival();
    } else if (state.mode === 'orbit') {
      context.orbit.update(dt);
    } else if (state.mode === 'top') {
      context.top.update(dt);
    } else if (state.mode === 'walk') {
      context.walk.update(dt);
      updateWalkPrompt();
    } else {
      context.fly.update(dt);
    }
  }

  easeFov(dt);
  if (context.planFlows) context.planFlows.sync(state.mode === 'top');
  refreshResident();
  refreshHover();
  renderer.render(scene, camera);
  if (context.labels) context.labels.update(now, window.innerWidth, window.innerHeight);
  if (context.minimap) context.minimap.update(now);
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

  // 0b-bis. Every hover target kind must survive the outline pass. A region
  //     target -- a folder above a district -- reached `showOutlineFor` with no
  //     `building`, read `building.x` and took the whole viewer down before the
  //     first frame; the check drives the function directly rather than trying
  //     to raycast a plinth, so it cannot flake.
  {
    const region = (state.source.manifest.regions || [])[0];
    if (region) {
      // Leave the view exactly as the probe found it. `applyHover` skips work
      // when the target has not changed, so a probe that hides the outline
      // without touching `hover.target` would leave the *next* check reading a
      // stale outline for a building it is still hovering.
      const restore = hover.target;
      const wasVisible = context.hoverOutline ? context.hoverOutline.visible : false;
      let ok = true;
      let detail = 'region outline suppressed';
      try {
        showOutlineFor({ kind: 'region', region });
        ok = context.hoverOutline.visible === false;
        if (!ok) detail = 'a region left the hover outline visible';
      } catch (error) {
        ok = false;
        detail = String(error && error.message ? error.message : error);
      } finally {
        if (restore) showOutlineFor(restore);
        else if (context.hoverOutline) context.hoverOutline.visible = wasVisible;
      }
      check('hover-region-outline', ok, detail);
    } else {
      check('hover-region-outline', true, 'no regions in this manifest');
    }
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
  const folderRows = [...document.querySelectorAll('#cityhall-body tr[data-folder-row]')];
  const unresolved = folderRows.filter((tr) => tr.dataset.folderRow === '').length;
  check('city-hall-folders-resolve', state.source.locked || (folderRows.length > 0 && unresolved === 0),
    `${folderRows.length - unresolved} of ${folderRows.length} folder rows fly to their district`);

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

  // (c4) Pause holds the camera and the clock; Resume carries on from there.
  {
    const tour = context.tour;
    // Somewhere mid-leg, where a frozen clock is easy to tell from a moving one.
    const leg = tour.route.segments.find((segment) => segment.type === 'travel');
    tour.elapsed = leg.start + leg.duration / 2;
    tour.update(0);
    document.getElementById('tour-pause').click();
    const heldAt = camera.position.clone();
    const heldClock = tour.elapsed;
    for (let i = 0; i < 40; i++) tour.update(1 / 20);
    const drift = camera.position.distanceTo(heldAt);
    const label = document.getElementById('tour-pause').textContent;
    document.getElementById('tour-pause').click();
    tour.update(1 / 20);
    const resumed = camera.position.distanceTo(heldAt);
    check(
      'tour-pause-resume',
      drift < 1e-6 && tour.elapsed - heldClock < 0.051 && label === 'Resume' && !tour.paused && resumed > 0,
      `held ${drift.toFixed(4)}m over 2s paused (button "${label}"), moved ${resumed.toFixed(2)}m on resume`
    );
  }

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
    const expected = HEALTH_SECTIONS.length + (manifest.delta ? 1 : 0) +
      (manifest.dependencies && manifest.dependencies.matrix && manifest.dependencies.matrix.length ? 1 : 0) +
      ((manifest.mainSequence || []).length ? 1 : 0) +
      (manifest.externals && manifest.externals.packages && manifest.externals.packages.length ? 1 : 0) +
      ((manifest.census || []).length >= 2 ? 1 : 0) + 1;
    check('health-tab', manifest.review ? cards === expected : cards === 0, `${cards} health cards of ${expected}`);
  }

  // 5f. The next layer: selection overlays, folder focus, the new lenses,
  //     query words, the History slider, saved views and notes.
  {
    const manifest = state.source.manifest;
    const flags = manifest.flags || {};
    const overlay = context.overlay;

    const linked = context.resident.find((b) => (b.importsOut || 0) > 0);
    if (linked && context.edges) {
      context.inspector.showBuilding(linked);
      await updateSelection({ kind: 'building', building: linked });
      const lines = overlay.group.children.filter((c) => c.name.startsWith('import-lines'));
      check('overlay-import-lines', lines.length > 0, `${lines.length} line meshes for ${linked.importsOut} imports`);
      state.hiddenLayers.add('imports');
      applyHiddenLayers();
      const hidden = lines.every((l) => !l.visible);
      state.hiddenLayers.delete('imports');
      applyHiddenLayers();
      check('overlay-switch', hidden && lines.every((l) => l.visible), 'import lines follow their City Guide switch');
      const structure = document.getElementById('inspector-metrics').textContent;
      check('inspector-structure', /Imports/.test(structure) && /Instability|Imported by|file/.test(structure), 'Structure section present');
      context.inspector.hide();
      await updateSelection(null);
      check('overlay-clears', overlay.group.children.length === 0, `${overlay.group.children.length} left`);
    } else {
      check('overlay-import-lines', true, 'no resolved imports in this city');
    }

    const district = manifest.districts.find((d) => d.buildings > 0 && d.buildings < context.resident.length);
    if (district && context.city) {
      context.inspector.showDistrict(district);
      await updateSelection({ kind: 'district', district });
      const outside = context.resident.filter((b) => b.district !== district.id && b.districtId !== district.id);
      const ghosted = context.city._filtered ? context.city._filtered.touched.length : 0;
      const shownOutside = outside.filter((b) => !state.hiddenArchetypes.has(b.archetype)).length;
      check('district-focus-fade', ghosted >= shownOutside && ghosted > 0, `${ghosted} faded, ${shownOutside} outside the folder`);
      const wantsLinks = manifest.dependencies && ((manifest.dependencies.matrix || []).some((r) => r[0] === district.id || r[1] === district.id) ||
        (manifest.dependencies.coupling || []).some((r) => r[0] === district.id || r[1] === district.id));
      const arcs = overlay.group.children.filter((c) => c.name.startsWith('district-links')).length;
      check('district-links', wantsLinks ? arcs > 0 : arcs === 0, `${arcs} arc meshes`);
      context.inspector.hide();
      await updateSelection(null);
      check('focus-clears', !context.city._filtered || Boolean(state.filterText), 'fade removed with the selection');
    } else {
      check('district-focus-fade', true, 'single-district city');
    }

    const mesh = [...context.city.meshes.values()].find((m) => m.userData.baseColors && m.count > 1);
    if (mesh) {
      const lensChanges = {};
      for (const lens of ['instability', 'tests', 'complexity', 'delta', 'territory']) {
        const before = Array.from(mesh.userData.baseColors);
        applyLens(lens);
        const after = Array.from(mesh.userData.baseColors);
        lensChanges[lens] = before.some((v, i) => Math.abs(v - after[i]) > 1e-3);
      }
      const keyItems = document.querySelectorAll('#lens-key span.chip').length;
      applyLens('archetype');
      check('new-lenses-recolour', lensChanges.instability || !flags.imports, JSON.stringify(lensChanges));
      check('lens-key-bands', keyItems > 0, `${keyItems} key entries for the last lens`);
    }

    // Query words: OR is a union, district: and imports: resolve.
    const a = countFor('is:hotspot') || 0;
    const b = countFor('is:test') || 0;
    const both = countFor('is:hotspot is:test') || 0;
    const either = countFor('is:hotspot OR is:test') || 0;
    check('query-or', either === a + b - both, `${a} + ${b} - ${both} = ${either}`);
    if (district) {
      const inFolder = countFor(`district:${state.source.s(district.key)}`) || 0;
      check('query-district', inFolder >= district.buildings, `${inFolder} for ${district.buildings} buildings`);
    }
    if (context.edges && context.edges.imports.size) {
      const [from, targets] = context.edges.imports.entries().next().value;
      const col = columnIndex(manifest.indexColumns);
      const target = indexRowById().get(targets[0]);
      const predicate = compileQuery(`imports:${state.source.s(target[col.path])}`);
      const row = indexRowById().get(from);
      check('query-imports', Boolean(predicate && row && predicate(row)), `imports:${state.source.s(target[col.path])}`);
    }
    const owner = manifest.stats.authors && manifest.stats.authors[0];
    if (owner && flags.authorship) {
      const name = state.source.s(owner.name).split(' ')[0].toLowerCase();
      check('query-owner', (countFor(`owner:${name}`) || 0) > 0, `owner:${name}`);
    }

    // The History slider: part of the city before its newest files existed.
    const span = historySpan();
    if (span > 0) {
      setTimeline(span * 0.5);
      const shown = [...context.city.meshes.values()]
        .filter((m) => m.name.startsWith('buildings-'))
        .reduce((sum, m) => {
          const matrix = new THREE.Matrix4();
          let n = 0;
          for (let i = 0; i < m.count; i++) {
            m.getMatrixAt(i, matrix);
            if (Math.abs(matrix.elements[0]) > 1e-6) n++;
          }
          return sum + n;
        }, 0);
      const younger = context.resident.filter((x) => (x.ageDays || 0) < span * 0.5).length;
      const cranes = context.city.group.getObjectByName('cranes');
      const cranesHidden = !cranes || cranes.visible === false;
      setTimeline(null);
      const restoredCranes = context.city.group.getObjectByName('cranes');
      check('timeline-replays', shown === context.resident.length - younger && cranesHidden,
        `${shown} standing halfway through ${Math.round(span)} days (${younger} not yet built), props hidden: ${cranesHidden}`);
      check('timeline-restores', !restoredCranes || restoredCranes.visible === !state.hiddenLayers.has('churn'), 'props back');
    } else {
      check('timeline-replays', true, 'no history span');
    }

    // Saved views round-trip through the URL hash.
    const view = currentView();
    const parsed = viewFromHash(viewToHash({ ...view, f: 'is:hotspot' }));
    check('view-roundtrip',
      Boolean(parsed) && Math.abs(parsed.position.x - camera.position.x) < 0.2 && parsed.filter === 'is:hotspot',
      parsed ? `(${parsed.position.x}, ${parsed.position.y}, ${parsed.position.z})` : 'unreadable');

    // Notes pin a building; removing the note removes the pin.
    const notes = context.notes;
    const sample = context.resident.find((x) => x.archetype !== 'park') || context.resident[0];
    if (notes && notes.available && !state.source.locked && sample) {
      const path = state.source.s(sample.path);
      const had = notes.get(path);
      notes.set(path, 'selftest note');
      rebuildCity(context.resident);
      const pins = context.city.group.getObjectByName('note-pins');
      notes.set(path, had);
      rebuildCity(context.resident);
      const after = context.city.group.getObjectByName('note-pins');
      check('notes-pin', Boolean(pins && pins.count >= 1) && (!after || had), `${pins ? pins.count : 0} pin(s)`);
    } else {
      check('notes-pin', true, 'notes unavailable (storage or locked)');
    }

    // Every new prop cluster that has a resident building to stand on exists.
    const expectations = [
      ['no-entry-signs', flags.layering, (x) => x.violations > 0],
      ['traffic-cones', flags.tests, (x) => x.untestedRisk],
      ['cross-bracing', flags.complexity, (x) => x.braced],
      ['survey-stakes', flags.delta, (x) => Boolean(x.delta)],
      ['owner-notices', flags.codeowners, (x) => x.ownerDrift],
      ['smoke-plumes', flags.defects, (x) => x.bugprone],
      ['potholes', flags.debt, (x) => x.debt > 0],
      ['code-notices', flags.codes, (x) => x.codeViolations && x.codeViolations.length > 0],
      ['plinth-shadows', (manifest.regions || []).length > 0, () => true],
      ['defect-lamps', flags.defects, (x) => x.isDefect],
      ['hub-collars', flags.hubs, (x) => x.isHub && (x.height || 0) > 6],
      ['debt-tags', flags.debt, (x) => x.debtMarkers && x.debtMarkers.length > 0],
      ['survey-stakes-ghosts', flags.delta, (x) => Boolean(x.baselineHeight)],
    ];
    // Props stand only on the detailed (near) tier, so only a building drawn
    // there can be expected to carry one -- whichever files happen to sit near
    // the camera is a property of the repository, not of the viewer.
    const nearTier = [];
    for (const [uuid, members] of context.city.records) {
      const mesh = context.city.meshes.get(uuid);
      if (mesh && !mesh.name.endsWith('-far')) nearTier.push(...members);
    }
    const missing = expectations
      .filter(([, on, test]) => on && nearTier.some(test))
      .filter(([name]) => !context.city.group.getObjectByName(name))
      .map(([name]) => name);
    check('new-props-drawn', missing.length === 0, missing.length ? `missing ${missing.join(', ')}` : 'all present');
  }

  // 5h. Materials by default, one flat colour under a data lens.
  {
    const buildingMeshes = [...context.city.meshes.values()].filter((m) => m.name.startsWith('buildings-'));
    const detailed = buildingMeshes.filter((m) => !m.name.endsWith('-far'));
    const far = buildingMeshes.filter((m) => m.name.endsWith('-far'));
    applyLens('archetype');
    const painted = detailed.filter((m) => m.geometry.attributes.color && m.material.vertexColors === true);
    check('multicolour-default',
      detailed.length > 0 && painted.length === detailed.length && far.every((m) => !m.material.vertexColors),
      `${painted.length}/${detailed.length} detailed forms painted, far tier ${far.filter((m) => m.material.vertexColors).length} painted`);
    applyLens('author');
    const flat = detailed.every((m) => m.material.vertexColors === false);
    applyLens('archetype');
    const back = detailed.every((m) => m.material.vertexColors === true);
    check('lens-flattens', flat && back, `flat under "author": ${flat}, painted again under "archetype": ${back}`);
  }

  // 5g. The third layer: blast radius, the new lenses and query words, and
  //     the Health cards for zones, the harbour and the census.
  {
    const manifest = state.source.manifest;
    const flags = manifest.flags || {};
    const overlay = context.overlay;
    const foundation = context.resident
      .filter((b) => (b.impact || 0) > 0)
      .sort((x, y) => (y.impact || 0) - (x.impact || 0))[0];
    if (foundation && context.edges) {
      await updateSelection({ kind: 'building', building: foundation });
      const floods = overlay.group.children.filter((c) => c.name.startsWith('impact-rings'));
      const summary = overlay.summary || {};
      check('impact-rings', floods.length > 0 && (summary.impact || 0) >= 1,
        `${summary.impact || 0} downstream (analyzer: ${foundation.impact}), ${summary.flooded || 0} discs in ${floods.length} meshes`);
      state.hiddenLayers.add('impact');
      applyHiddenLayers();
      const hidden = floods.every((m) => !m.visible);
      state.hiddenLayers.delete('impact');
      applyHiddenLayers();
      check('impact-switch', hidden && floods.every((m) => m.visible), 'flood discs follow their City Guide switch');
      await updateSelection(null);
    } else {
      check('impact-rings', !flags.imports || !context.resident.some((b) => b.impact > 0), 'nothing imports anything resident');
    }

    const mesh = [...context.city.meshes.values()].find((m) => m.userData.baseColors && m.count > 1);
    if (mesh) {
      const changed = {};
      for (const lens of ['impact', 'defects']) {
        const before = Array.from(mesh.userData.baseColors);
        applyLens(lens);
        changed[lens] = before.some((v, i) => Math.abs(v - mesh.userData.baseColors[i]) > 1e-3);
      }
      applyLens('archetype');
      check('third-lenses-recolour', changed.impact || !flags.imports, JSON.stringify(changed));
    }

    // New query words: counts agree with the analyzer's own totals.
    const totals = (manifest.review && manifest.review.totals) || {};
    const bugprone = countFor('is:bugprone') || 0;
    const coded = countFor('is:codes') || 0;
    const reach = countFor('impact>0 -is:test') || 0;
    check('query-third-layer', bugprone === (totals.bugprone || 0) && coded === (totals.codes || 0) && reach >= (totals.impact || 0),
      `is:bugprone ${bugprone}/${totals.bugprone || 0}, is:codes ${coded}/${totals.codes || 0}, impact>0 ${reach}/${totals.impact || 0}`);
    const zones = (manifest.mainSequence || []).filter((r) => r[4]).length;
    check('query-zone', !zones || (countFor('zone:pain OR zone:useless') || 0) > 0, `${zones} folder(s) in a zone`);

    const panel = document.getElementById('guide-health');
    const wantZones = (manifest.mainSequence || []).length > 0;
    const wantHarbour = Boolean(manifest.externals && manifest.externals.packages && manifest.externals.packages.length);
    const hasZones = Boolean(panel && panel.querySelector('[data-section="zones"] svg.main-sequence'));
    const hasHarbour = Boolean(panel && panel.querySelector('[data-section="externals"] table'));
    check('health-third-cards', hasZones === wantZones && hasHarbour === wantHarbour,
      `zones ${hasZones}/${wantZones}, harbour ${hasHarbour}/${wantHarbour}, census ${(manifest.census || []).length} build(s)`);
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

  // 5a. The deeper signals: filter words agree with the analyzer's totals, and
  //     a selected building draws its hidden-coupling and clone partners.
  {
    const manifest = state.source.manifest;
    const review = manifest.review || {};
    const totals = review.totals || {};
    const counts = {
      defect: countFor('is:defect'), rising: countFor('is:rising'), hub: countFor('is:hub'),
      hiddencoupling: countFor('is:hiddencoupling'), clone: countFor('is:clone'), debt: countFor('is:debt'),
    };
    const debtFiles = (manifest.districts || []).reduce((sum, d) => sum + (d.debt ? 1 : 0), 0);
    check('filter-deeper-words',
      (counts.defect || 0) === (totals.defects || 0) && (counts.rising || 0) === (totals.rising || 0) &&
        (counts.hub || 0) === (totals.hubs || 0) && (totals.debt ? (counts.debt || 0) > 0 && debtFiles > 0 : !counts.debt),
      JSON.stringify(counts));

    const overlay = context.overlay;
    const withHidden = context.resident.find((b) => b.hiddenCoupling && b.hiddenCoupling.length);
    if (overlay && withHidden) {
      context.inspector.showBuilding(withHidden);
      await updateSelection({ kind: 'building', building: withHidden });
      const arcs = overlay.group.children.filter((c) => c.name === 'hidden-arcs');
      check('overlay-hidden-coupling', arcs.length === 1, `${arcs.length} dashed arc meshes for ${withHidden.hiddenCoupling.length} partners`);
      const text = context.inspector.metrics.textContent;
      check('inspector-hidden-coupling', /Hidden coupling/.test(text), 'the Structure section names the partners');
      context.inspector.hide();
      await updateSelection(null);
    } else {
      check('overlay-hidden-coupling', true, 'no hidden coupling in this city');
      check('inspector-hidden-coupling', true, 'no hidden coupling in this city');
    }
    const withClone = context.resident.find((b) => b.cloneOf && b.cloneOf.length);
    if (overlay && withClone) {
      await updateSelection({ kind: 'building', building: withClone });
      const links = overlay.group.children.filter((c) => c.name === 'clone-links');
      check('overlay-clones', links.length === 1, `${links.length} twin link meshes`);
      await updateSelection(null);
    } else {
      check('overlay-clones', true, 'no clone twins in this city');
    }

    // The go-to palette finds a file by a fuzzy fragment and flies to it.
    if (context.palette && !state.source.locked && context.facetIndex && context.facetIndex.length) {
      const col = columnIndex(manifest.indexColumns);
      const row = context.facetIndex.find((r) => (state.source.s(r[col.path]) || '').includes('/')) || context.facetIndex[0];
      const path = state.source.s(row[col.path]);
      const name = path.split('/').pop();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true, bubbles: true }));
      const opened = context.palette.isOpen;
      const input = document.querySelector('#palette input');
      input.value = name.slice(0, Math.max(3, name.length - 2));
      input.dispatchEvent(new Event('input'));
      const found = context.palette.results.some((item) => item.kind === 'building' && item.id === row[col.id]);
      const pickIndex = context.palette.results.findIndex((item) => item.id === row[col.id] && item.kind === 'building');
      context.palette.index = Math.max(0, pickIndex);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      const flying = context.flight.active || !context.palette.isOpen;
      check('palette-go-to', opened && found && flying && !context.palette.isOpen,
        `"${input.value}" → ${found ? path : 'not found'}${flying ? ', flying' : ''}`);
      context.flight.active = false;
      await new Promise((resolve) => setTimeout(resolve, 20));
      context.inspector.hide();
    } else {
      check('palette-go-to', true, 'locked or no index');
    }

    // The CSV export has a row per file and a signal column that agrees with the index.
    if (!state.source.locked && context.facetIndex) {
      const text = csvText();
      const rows = text.trim().split('\n');
      const hubs = rows.filter((line) => /(^|[ ,])hub( |$)/.test(line.split(',').pop())).length;
      check('csv-export', rows.length === context.facetIndex.length + 1 && hubs === ((manifest.review || {}).totals || {}).hubs,
        `${rows.length - 1} rows for ${context.facetIndex.length} files, ${hubs} hubs`);
    } else {
      check('csv-export', true, 'locked');
    }

    // Every new lens paints something, and its key counts every resident building.
    const lensSelect = document.getElementById('lens-select');
    const before = lensSelect.value;
    const failed = [];
    for (const lens of ['trend', 'defects', 'debt', 'depth', 'coupling', 'mainsequence', 'language', 'archetype', 'author']) {
      applyLens(lens);
      const keyTotal = [...document.querySelectorAll('#lens-key > span')]
        .map((span) => Number((span.textContent.split('·').pop() || '').replace(/[^\d]/g, '')) || 0)
        .reduce((a, v) => a + v, 0);
      if (keyTotal !== context.resident.length) failed.push(`${lens}: key ${keyTotal} of ${context.resident.length}`);
    }
    applyLens(before);
    check('deeper-lenses-keyed', failed.length === 0, failed.join('; ') || 'nine lenses, every building counted');

    // The City Guide's "Colour buildings by" drives the same lens as the Filter tab.
    const guideLens = document.getElementById('guide-lens');
    const sample = [...context.city.meshes.values()].find((m) => m.userData.baseColors && m.count > 1);
    if (guideLens && sample) {
      const colourBefore = Array.from(sample.userData.baseColors);
      guideLens.value = 'language';
      guideLens.dispatchEvent(new Event('change'));
      const colourAfter = Array.from(sample.userData.baseColors);
      const synced = document.getElementById('lens-select').value === 'language';
      const keyed = document.querySelectorAll('#guide-lens-key span.chip').length > 0;
      const languages = new Set(context.resident.map((b) => b.language)).size;
      const recoloured = languages < 2 || colourBefore.some((v, i) => Math.abs(v - colourAfter[i]) > 1e-3);
      check('guide-colour-by', synced && keyed && recoloured,
        `filter select ${synced ? 'in step' : 'out of step'}, key ${keyed ? 'shown' : 'missing'}, ${recoloured ? 'recoloured' : 'unchanged'}`);
      applyLens(before);
    } else {
      check('guide-colour-by', Boolean(guideLens), 'no mesh to sample');
    }
  }

  // 5b. Plan view and minimap.
  {
    const startPosition = context.fly.position.clone();
    const startYaw = context.fly.yaw;
    const startPitch = context.fly.pitch;
    setMode('top');
    context.flight.update(10);
    context.top.update(0);
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    check('plan-view-overhead', state.mode === 'top' && forward.y < -0.99,
      `mode ${state.mode}, forward.y ${forward.y.toFixed(4)}`);
    // Out, then back in: whichever end of the range the plan opened at, one of
    // the two moves is free, and both must be answered.
    const heightBefore = context.top.height;
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, clientX: 400, clientY: 300, bubbles: true, cancelable: true }));
    const heightOut = context.top.height;
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, clientX: 400, clientY: 300, bubbles: true, cancelable: true }));
    const heightIn = context.top.height;
    check('plan-view-zoom', heightOut > heightBefore - 1e-6 && heightIn < heightOut && (heightOut > heightBefore || heightIn < heightBefore),
      `${heightBefore.toFixed(0)}m -> out ${heightOut.toFixed(0)}m -> in ${heightIn.toFixed(0)}m`);
    const planView = viewFromHash(viewToHash(currentView()));
    check('plan-view-link', Boolean(planView) && planView.mode === 'top', planView ? planView.mode : 'unreadable');
    const planPosition = camera.position.clone();
    setMode('fly');
    check('plan-view-handoff',
      state.mode === 'fly' && context.fly.position.distanceTo(planPosition) < 1e-3 && context.fly.pitch < -1.5,
      `moved ${context.fly.position.distanceTo(planPosition).toFixed(4)}m, pitch ${context.fly.pitch.toFixed(3)}`);

    const minimap = context.minimap;
    if (minimap) {
      const wasCollapsed = minimap.collapsed;
      minimap.toggle(false);
      const draw = () => {
        minimap.lastDraw = -Infinity;
        minimap.update(performance.now());
        const { width, height } = minimap.canvas;
        const data = minimap.ctx.getImageData(0, 0, width, height).data;
        let lit = 0;
        let sum = 0;
        for (let i = 0; i < data.length; i += 4) {
          const v = data[i] + data[i + 1] + data[i + 2];
          sum += v * ((i >> 2) % 97 + 1);
          if (v > 60) lit++;
        }
        return { lit, sum, total: width * height };
      };
      const archetypeDraw = draw();
      check('minimap-drawn', archetypeDraw.lit > archetypeDraw.total * 0.05,
        `${archetypeDraw.lit} of ${archetypeDraw.total} pixels lit`);

      const lensBefore = document.getElementById('lens-select').value;
      applyLens('heat');
      const heatDraw = draw();
      applyLens(lensBefore);
      check('minimap-lens-follows', heatDraw.sum !== archetypeDraw.sum || context.resident.length === 0,
        'district tint follows the colour lens');

      // Click the centre of the largest district: the camera must fly there.
      const district = [...state.source.manifest.districts].sort((a, b) => b.rect[2] * b.rect[3] - a.rect[2] * a.rect[3])[0];
      const click = (world) => {
        const t = minimap._transform();
        const rect = minimap.canvas.getBoundingClientRect();
        const ratio = t.width / Math.max(1, rect.width);
        const clientX = rect.left + (world.x * t.scale + t.ox) / ratio;
        const clientY = rect.top + (world.z * t.scale + t.oz) / ratio;
        const init = { clientX, clientY, button: 0, pointerId: 7, bubbles: true };
        minimap.canvas.dispatchEvent(new PointerEvent('pointerdown', init));
        minimap.canvas.dispatchEvent(new PointerEvent('pointerup', init));
      };
      if (district) {
        const centre = districtCentre(district);
        click(centre);
        context.flight.update(10);
        // Where does the view ray meet the ground the flight aimed at?
        const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
        const aimY = district.skyline.maxHeight * 0.4;
        const t = (aimY - camera.position.y) / (fwd.y || -1e-6);
        const hitX = camera.position.x + fwd.x * t;
        const hitZ = camera.position.z + fwd.z * t;
        const miss = Math.hypot(hitX - centre.x, hitZ - centre.z);
        const tolerance = Math.max(3, minimap._window()[2] / 150);
        check('minimap-click-flies', state.mode === 'fly' && miss < tolerance,
          `aimed ${miss.toFixed(1)}m from the clicked point (tolerance ${tolerance.toFixed(1)}m)`);

        setMode('top');
        context.flight.update(10);
        click(centre);
        context.flight.update(10);
        context.top.update(0);
        const planMiss = Math.hypot(context.top.target.x - centre.x, context.top.target.z - centre.z);
        check('minimap-click-plan', state.mode === 'top' && planMiss < tolerance,
          `plan centred ${planMiss.toFixed(1)}m from the clicked point`);
        setMode('fly');
      } else {
        check('minimap-click-flies', true, 'no districts');
        check('minimap-click-plan', true, 'no districts');
      }

      minimap.toggle(true);
      const hidden = getComputedStyle(minimap.canvas).display === 'none';
      const pillShown = getComputedStyle(minimap.root.querySelector('.minimap-pill')).display !== 'none';
      minimap.toggle(false);
      const back = getComputedStyle(minimap.canvas).display !== 'none';
      check('minimap-collapse', hidden && pillShown && back, `collapsed ${hidden}, pill ${pillShown}, restored ${back}`);
      minimap.toggle(wasCollapsed);
    } else {
      check('minimap-drawn', false, 'no minimap');
    }

    context.flight.active = false;
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

/** The reader's notes, keyed by the repository's name once it is readable. */
function setupNotes() {
  const manifest = state.source.manifest;
  const name = manifest.meta && manifest.meta.name >= 0 ? state.source.s(manifest.meta.name) : '';
  context.notes = new Notes(state.source.locked ? 'locked' : `${name || 'repo'}`);
  if (context.inspector) context.inspector.notes = context.notes;
  context.notes.onChange(() => {
    renderHealth();
    scheduleRebuild();
    if (context.minimap) context.minimap.invalidate();
  });
}

async function boot() {
  const progress = (text) => {
    loadingText.textContent = text;
  };
  // Before the first rebuild, which reads the lens off this select: a fresh
  // page colours buildings by what they are made of, or by the reader's last
  // choice; the self-test keeps the archetype colours its checks expect.
  const lensSelect = document.getElementById('lens-select');
  if (lensSelect) lensSelect.value = initialLens();
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

  // What a selection is connected to, drawn only for the selection.
  context.overlay = new SelectionOverlay(THREE, scene);

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
  // Import edges: ids only, so the same whether the city is locked or not.
  context.edges = manifest.imports ? edgeMaps(await state.source.imports()) : null;
  setupNotes();
  setupFilterAndLens();
  renderChips();
  rebuildCity(context.resident);
  // The first build is valid around the opening camera, so a later rebuild is
  // only due once the camera has actually travelled from here.
  lodCentre = { x: camera.position.x, z: camera.position.z };
  lodRebuiltAt = performance.now();

  context.fly = new FlyCamera(THREE, camera, bounds);
  context.orbit = new OrbitCamera(THREE, camera, bounds);
  context.top = new TopCamera(THREE, camera, bounds, maxHeightOf(manifest));
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
  context.inspector.edges = context.edges;
  context.inspector.notes = context.notes;
  context.inspector.onDistrict = (id) => {
    const district = state.source.manifest.districts[id];
    if (!district) return;
    teleportTo({ kind: 'district', district });
    context.inspector.showDistrict(district);
  };
  context.inspector.onSelect = (selection) => {
    updateSelection(selection).catch(() => {});
    if (context.minimap) context.minimap.invalidate();
  };
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
    pause: document.getElementById('tour-pause'),
    // The tour keeps this in step so handing control back never moves the view.
    fly: context.fly,
    // Show the viewer which block is being described.
    onStop: (district) => {
      placeDistrictMarker(context.tourDistrictMarker, district.rect, 0.18);
      // Light up everything that belongs to this district, not just its outline.
      if (context.city) context.city.highlightDistrict(district.id);
    },
  });
  {
    const controls = document.getElementById('controls');
    const hud = document.getElementById('hud');
    const measure = () => hud.style.setProperty('--controls-height', `${controls.offsetHeight}px`);
    measure();
    if (window.ResizeObserver) new ResizeObserver(measure).observe(controls);
  }
  document.getElementById('tour-pause').addEventListener('click', (event) => {
    context.tour.togglePause();
    setTourPrompt();
    // Drop focus so Space goes back to meaning "take over", not "press again".
    event.currentTarget.blur();
  });

  context.fly.setFromManifest(manifest.camera);
  context.orbit.frame(bounds);
  camera.far = manifest.camera.far;
  camera.fov = manifest.camera.fov;
  camera.updateProjectionMatrix();

  renderGuide();
  setupMapLabels();
  setupMiniMap();
  setupPlanFlows();
  setupPalette();
  setupGuideColour();
  applyLens(document.getElementById('lens-select').value);
  renderTitle();
  applyTime();
  setupHistory();
  setupViewLinks();

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

  // A shared link opens on the view it was taken from.
  if (!state.selftest && location.hash) await applyView(viewFromHash(location.hash));

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
