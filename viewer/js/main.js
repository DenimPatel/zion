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

function renderLegend() {
  const manifest = state.source.manifest;
  const list = document.getElementById('legend-list');
  list.innerHTML = '';
  for (const entry of manifest.legend || []) {
    const item = document.createElement('li');
    if (!entry.enabled) item.classList.add('disabled');
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    const label = document.createElement('span');
    label.textContent = entry.label;
    const unit = document.createElement('span');
    unit.className = 'legend-unit';
    unit.textContent = entry.enabled ? '' : 'off';
    item.append(swatch, label, unit);
    list.append(item);
  }

  const notes = document.getElementById('legend-notes');
  notes.innerHTML = '';
  if (state.source.locked) {
    const p = document.createElement('p');
    p.textContent =
      'Repo notes are encrypted. Press U and enter the passphrase to read them.';
    notes.append(p);
    return;
  }
  for (const note of manifest.stats.notes || []) {
    const p = document.createElement('p');
    p.textContent = state.source.s(note);
    notes.append(p);
  }
}

function renderXray() {
  const table = document.getElementById('xray-table');
  table.innerHTML = '';
  for (const [name, colour] of Object.entries(ARCHETYPE_COLORS)) {
    const row = document.createElement('tr');
    const label = document.createElement('td');
    label.textContent = archetypeLabel(name);
    const chipCell = document.createElement('td');
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.style.background = `#${colour.toString(16).padStart(6, '0')}`;
    chipCell.append(chip);
    row.append(label, chipCell);
    table.append(row);
  }
}

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
  mesh.build(buildings, {
    cameraXZ: { x: camera.position.x, z: camera.position.z },
  });
  // Stand-in massing for districts that are not resident, so streaming does not
  // leave a hard edge at the horizon.
  const residentIds = new Set(context.streamer ? context.streamer.resident.keys() : []);
  const impostors = createImpostors(THREE, state.source.manifest, residentIds);
  if (impostors) mesh.group.add(impostors);
  scene.add(mesh.group);
  if (previous) {
    scene.remove(previous.group);
    disposeGroup(previous.group);
  }
  context.city = mesh;
  hover.target = null;
  if (context.hoverOutline) context.hoverOutline.visible = false;

  context.grid = new CollisionGrid(buildings);
  if (context.hall) context.grid.addBox(context.hall.userData.box);
  if (context.walk) context.walk.grid = context.grid;
  applyTime();

  if (state.source.manifest.flags && state.source.manifest.flags.coupling && context.bridges) {
    const byId = new Map(buildings.map((b) => [b.id, b]));
    mesh.buildBridges(context.bridges, byId);
  }
}

async function refreshResident(force = false) {
  if (rebuilding || !context.streamer) return;
  rebuilding = true;
  try {
    const changed = await context.streamer.update(camera.position.x, camera.position.z, force);
    if (changed) {
      context.resident = context.streamer.buildings();
      state.source.buildings = context.resident;
      rebuildCity(context.resident);
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
    (child) => child.name === 'district-plates' || child.name === 'district-impostors'
  );
  if (!meshes.length) return null;
  const hits = raycaster.intersectObjects(meshes, false);
  if (!hits.length) return null;
  const hit = hits[0];
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
    if (target && (target.kind === 'building' || target.kind === 'district')) {
      context.city.setHighlight(target.mesh, target.instanceId, target.kind === 'district' ? 0.45 : 0.62);
    } else {
      context.city.clearHighlight();
    }
  }
  showOutlineFor(target);
  // A district is a folder, not an object, so it gets a ground outline of the
  // whole block rather than a box around one mesh.
  if (target && target.kind === 'district') {
    placeDistrictMarker(context.hoverDistrictMarker, target.district.rect);
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
      document.body.classList.toggle('legend-hidden');
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
  renderLegend();
  renderTitle();
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
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

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
  context.bridges = manifest.flags && manifest.flags.coupling ? await state.source.bridges() : [];
  rebuildCity(context.resident);

  context.fly = new FlyCamera(THREE, camera, bounds);
  context.orbit = new OrbitCamera(THREE, camera, bounds);
  context.flight = new CameraFlight(camera);
  context.walk = new WalkCamera(THREE, camera, context.grid, bounds);
  context.interior = new Interior(THREE, state.source, renderer);
  context.inspector = new Inspector(state.source);
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

  renderLegend();
  renderXray();
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
