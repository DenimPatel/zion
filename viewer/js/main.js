/**
 * Zion viewer entry point.
 *
 * Responsibilities: load the city, build the scene, run the render loop, wire
 * the HUD controls, and route picking to the inspector. All analysis happened
 * in Python; nothing here parses source.
 */

import * as THREE from 'three';
import { CitySource } from './loader.js';
import { CityMesh, ARCHETYPE_COLORS, archetypeLabel } from './city.js';
import { SkyRig } from './sky.js';
import { FlyCamera, OverviewCamera, CameraFlight } from './cameras.js';
import { Inspector, formatBytes } from './inspector.js';

const canvas = document.getElementById('scene');
const loading = document.getElementById('loading');
const loadingText = document.getElementById('loading-text');

const state = {
  source: new CitySource('.'),
  mode: 'fly',
  night: 0,
  litScale: 1,
  time: 12,
  bench: new URLSearchParams(location.search).has('bench'),
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

let city = null;
let sky = null;
let fly = null;
let overview = null;
let flight = null;
let inspector = null;
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

function resize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
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

// ---------------------------------------------------------------------------
// Picking
// ---------------------------------------------------------------------------

function toNdc(event) {
  pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;
}

function pick(event) {
  if (!city) return;
  toNdc(event);
  raycaster.setFromCamera(pointer, camera);
  const targets = city.group.children.filter(
    (child) => child.isInstancedMesh && child.name.startsWith('buildings-')
  );
  const hits = raycaster.intersectObjects(targets, false);
  if (hits.length) {
    const hit = hits[0];
    const records = city.records.get(hit.object.uuid);
    const building = records && records[hit.instanceId];
    if (building) {
      inspector.showBuilding(building);
      return;
    }
  }
  inspector.hide();
}

canvas.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  if (event.shiftKey) return; // shift-drag is a look gesture in fly mode
  if (document.pointerLockElement === canvas) return;
  pick(event);
});

canvas.addEventListener('click', () => {
  if (state.mode === 'fly') fly.requestPointerLock(canvas);
});

window.addEventListener('keydown', (event) => {
  if (event.code === 'KeyO') {
    state.mode = state.mode === 'overview' ? 'fly' : 'overview';
    applyMode();
  } else if (event.code === 'KeyL') {
    document.body.classList.toggle('legend-hidden');
  }
});

function applyMode() {
  const isOverview = state.mode === 'overview';
  fly.enabled = !isOverview;
  overview.active = isOverview;
  if (isOverview) {
    overview.frame(state.source.manifest.bounds);
    document.exitPointerLock?.();
  }
}

// ---------------------------------------------------------------------------
// Time of day
// ---------------------------------------------------------------------------

function applyTime() {
  state.night = sky.setTime(state.time);
  city.setGlow(state.night * state.litScale);
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
// Render loop and benchmark mode
// ---------------------------------------------------------------------------

const bench = {
  frames: [],
  start: performance.now(),
  last: performance.now(),
};

function recordBench(dt) {
  if (!state.bench || benchReported) return;
  bench.frames.push(dt * 1000);
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

/**
 * A deterministic benchmark sweep.
 *
 * Frame times here are measured under whatever renderer the page got -- under
 * headless SwiftShader they are not GPU-representative, so the gates that
 * matter are the deterministic ones: draw calls and the resident building
 * count. The sweep still moves the camera so streaming and culling are
 * exercised.
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
    // Discard the first few frames: shader compilation and texture upload are
    // one-time costs, not frame cost.
    if (i >= 5) times.push(performance.now() - started);
  }

  const info = renderer.info.render;
  // Under Chrome's --virtual-time-budget the clock does not advance during a
  // synchronous loop, so reported frame times would be a flattering fiction.
  // Say so rather than publishing a fake number; draw calls and resident
  // counts stay meaningful either way.
  const measurable = times.some((value) => value > 0.0001);
  const payload = {
    marker: 'ZION_BENCH',
    timingMode: measurable ? 'real' : 'virtual-time (frame times unavailable)', 
    drawCalls: info.calls,
    triangles: info.triangles,
    buildings: state.source.buildings.length,
    districts: state.source.districts.length,
    residentChunks: state.source.districts.length,
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

let benchReported = false;

let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  if (flight.active) {
    flight.update(dt);
  } else if (state.mode === 'overview') {
    overview.update(dt);
  } else {
    fly.update(dt);
  }

  renderer.render(scene, camera);
  recordBench(dt);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  const progress = (text) => {
    loadingText.textContent = text;
  };
  try {
    progress('reading manifest');
    const manifest = await state.source.load(progress);
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
  progress('placing buildings');
  const buildings = await state.source.loadAll(progress);
  state.source.buildings = buildings;

  city = new CityMesh(THREE, state.source);
  scene.add(city.build(buildings));

  sky = new SkyRig(THREE, scene, manifest.bounds);
  fly = new FlyCamera(THREE, camera, manifest.bounds);
  overview = new OverviewCamera(THREE, camera, manifest.bounds);
  flight = new CameraFlight(camera);
  inspector = new Inspector(state.source);

  const [cx, cz] = [manifest.bounds[0] + manifest.bounds[2] / 2, manifest.bounds[1] + manifest.bounds[3] / 2];
  fly.setFromManifest(manifest.camera);
  overview.frame(manifest.bounds);
  camera.far = manifest.camera.far;
  camera.fov = manifest.camera.fov;
  camera.updateProjectionMatrix();

  renderLegend();
  renderXray();
  renderTitle();
  applyTime();

  canvas.addEventListener('dblclick', () => {
    const [bx, by, bz] = [cx, 0, cz];
    flight.start(
      camera.position.clone(),
      camera.quaternion.clone(),
      new THREE.Vector3(bx - 60, 40, bz - 60),
      new THREE.Vector3(bx, 0, bz),
      1.4
    );
  });

  loading.classList.add('done');
  window.zion = {
    // Exposed for headless verification and manual poking.
    state,
    scene,
    camera,
    renderer,
    city,
    runBench,
    flyTo: (x, y, z, tx, ty, tz) =>
      flight.start(
        camera.position.clone(),
        camera.quaternion.clone(),
        new THREE.Vector3(x, y, z),
        new THREE.Vector3(tx, ty, tz),
        0.4
      ),
  };

  if (state.bench) {
    // Dusk: the point of the metaphor, where lit windows are visible.
    state.time = 20.5;
    document.getElementById('time').value = state.time;
    applyTime();
    // Let the renderer compile shaders once, then run the measured sweep.
    renderer.render(scene, camera);
    setTimeout(() => runBench(60), 0);
  }

  requestAnimationFrame(frame);
}

boot();
