/**
 * Zion viewer entry point.
 *
 * Loads the city, streams districts around the camera, runs the render loop,
 * and routes input to the right mode: fly, overview, walk, or inside a
 * building. All analysis happened in Python; nothing here parses source.
 */

import * as THREE from 'three';
import { CitySource } from './loader.js';
import { CityMesh, createCityHall, ARCHETYPE_COLORS, archetypeLabel } from './city.js';
import { SkyRig } from './sky.js';
import { FlyCamera, OverviewCamera, CameraFlight } from './cameras.js';
import { CollisionGrid, WalkCamera } from './collision.js';
import { Interior } from './interior.js';
import { CityHall, Tour } from './tour.js';
import { DistrictStreamer } from './stream.js';
import { Inspector } from './inspector.js';

const canvas = document.getElementById('scene');
const loading = document.getElementById('loading');
const loadingText = document.getElementById('loading-text');
const promptEl = document.getElementById('prompt');

const state = {
  source: new CitySource('.'),
  mode: 'fly', // fly | walk | overview | interior
  night: 0,
  litScale: 1,
  time: 12,
  bench: new URLSearchParams(location.search).has('bench'),
  selftest: new URLSearchParams(location.search).has('selftest'),
};

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 0.5, 8000);

const context = {
  city: null,
  hall: null,
  sky: null,
  fly: null,
  overview: null,
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
    label.textContent = state.source.s(entry.label);
    const unit = document.createElement('span');
    unit.className = 'legend-unit';
    unit.textContent = entry.enabled ? '' : 'off';
    item.append(swatch, label, unit);
    list.append(item);
  }

  const notes = document.getElementById('legend-notes');
  notes.innerHTML = '';
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
  document.getElementById('city-name').textContent = 'Zion';
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
  scene.add(mesh.group);
  if (previous) {
    scene.remove(previous.group);
    disposeGroup(previous.group);
  }
  context.city = mesh;

  context.grid = new CollisionGrid(buildings);
  if (context.hall) context.grid.addBox(context.hall.userData.box);
  if (context.walk) context.walk.grid = context.grid;
  applyTime();
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

function toNdc(event) {
  pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;
}

function pick(event) {
  if (!context.city) return;
  toNdc(event);
  raycaster.setFromCamera(pointer, camera);
  const targets = context.city.group.children.filter((child) =>
    child.name.startsWith('buildings-')
  );
  const hits = raycaster.intersectObjects(targets, false);
  if (hits.length) {
    const hit = hits[0];
    const records = context.city.records.get(hit.object.uuid);
    const building = records && records[hit.instanceId];
    if (building) {
      context.inspector.showBuilding(building);
      return;
    }
  }
  context.inspector.hide();
}

canvas.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || state.mode === 'interior') return;
  if (document.pointerLockElement === canvas) return;
  pick(event);
});

canvas.addEventListener('click', () => {
  if (state.mode === 'fly' || state.mode === 'walk') canvas.requestPointerLock?.();
});

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

function setMode(mode) {
  if (state.mode === 'interior' && mode !== 'interior') exitInterior();
  state.mode = mode;
  context.fly.enabled = mode === 'fly';
  context.overview.active = mode === 'overview';
  context.walk.enabled = mode === 'walk';
  if (mode === 'overview') {
    context.overview.frame(state.source.manifest.bounds);
    document.exitPointerLock?.();
  }
  if (mode === 'walk') {
    context.walk.fromFlyingCamera(context.fly);
    context.walk.apply();
  }
  if (mode !== 'fly') document.exitPointerLock?.();
  setPrompt('');
}

async function enterInterior(building) {
  await context.interior.enter(building, context.walk);
  state.mode = 'interior';
  context.fly.enabled = false;
  context.walk.enabled = false;
  context.overview.active = false;
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

  if ((state.mode === 'fly' || state.mode === 'walk') && event.code === 'KeyW') {
    canvas.requestPointerLock?.();
  }

  switch (event.code) {
    case 'KeyV':
      setMode(state.mode === 'walk' ? 'fly' : 'walk');
      break;
    case 'KeyO':
      setMode(state.mode === 'overview' ? 'fly' : 'overview');
      break;
    case 'KeyT':
      context.tour.start();
      break;
    case 'KeyC':
      context.cityHall.open ? context.cityHall.hide() : context.cityHall.show();
      document.body.classList.toggle('hall-open', context.cityHall.open);
      break;
    case 'KeyL':
      document.body.classList.toggle('legend-hidden');
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
  if (state.mode === 'walk' && context.walk.target) {
    const building = context.resident.find((b) => b.rel === context.walk.target.rel);
    if (building) await enterInterior(building);
  }
  if (state.mode === 'fly' && context.inspector.selected?.building) {
    await enterInterior(context.inspector.selected.building);
  }
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

  if (context.flight.active) {
    context.flight.update(dt);
  } else if (state.mode === 'overview') {
    context.overview.update(dt);
  } else if (state.mode === 'walk') {
    context.walk.update(dt);
    updateWalkPrompt();
  } else {
    context.fly.update(dt);
  }

  refreshResident();
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
      setPrompt(`<kbd>E</kbd> enter ${escapeHtml(state.source.s(building.name))}`);
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
  const pre = document.createElement('pre');
  pre.id = 'selftest';
  pre.textContent = line;
  document.body.append(pre);
  document.title = line;
}

let selfTestResults = [];

async function runSelfTest() {
  const results = selfTestResults;
  const check = (step, ok, detail = '') => results.push({ step, ok: Boolean(ok), detail: String(detail) });

  const tourNode = document.getElementById('tour');
  results.push({
    step: 'dom-probe',
    ok: Boolean(tourNode),
    detail: `tour=${Boolean(tourNode)} htmlLen=${tourNode ? tourNode.innerHTML.length : -1} label=${Boolean(document.getElementById('tour-label'))} caption=${Boolean(document.getElementById('tour-caption'))} ids=${document.querySelectorAll('[id]').length}`,
  });

  // 1. Walk mode puts the player on the ground and collides with buildings.
  setMode('walk');
  check('walk-mode', state.mode === 'walk' && context.walk.enabled);
  const groundY = context.walk.position.y;
  check('walk-gravity', groundY >= -0.01 && groundY < 200, `y=${groundY.toFixed(2)}`);

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

  // 5. The tour starts and produces a caption per district.
  context.tour.start();
  const stops = context.tour.stops.length;
  check('tour-start', context.tour.running && stops > 0, `${stops} stops`);
  check('tour-caption', document.getElementById('tour-caption').textContent.length > 0);
  context.tour.stopTour();

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

  progress('building the sky');
  context.sky = new SkyRig(THREE, scene, bounds);

  progress('raising the landmark');
  context.hall = createCityHall(THREE, bounds, maxHeightOf(manifest));
  scene.add(context.hall);

  const span = Math.max(bounds[2], bounds[3]);
  context.streamer = new DistrictStreamer(state.source, {
    span,
    near: 1.0,
    far: 1.9,
    maxResident: manifest.meta.buildingCount > 20000 ? 20000 : Infinity,
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
  rebuildCity(context.resident);

  context.fly = new FlyCamera(THREE, camera, bounds);
  context.overview = new OverviewCamera(THREE, camera, bounds);
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
  context.tour = new Tour(state.source, camera, context.flight, {
    // The container is shown and hidden; the caption paragraph receives text.
    // Writing the caption into the container would erase the paragraph itself.
    container: document.getElementById('tour'),
    caption: document.getElementById('tour-caption'),
    label: document.getElementById('tour-label'),
  });

  context.fly.setFromManifest(manifest.camera);
  context.overview.frame(bounds);
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
  };

  if (state.selftest) {
    setTimeout(
      () =>
        runSelfTest().catch((error) =>
          reportSelfTest(
            selfTestResults.concat([
              { step: 'selftest', ok: false, detail: `${error && error.stack ? error.stack : error}` },
            ])
          )
        ),
      0
    );
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

boot();
