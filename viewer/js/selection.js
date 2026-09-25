/**
 * What the current selection is connected to, drawn only for the selection.
 *
 * Skybridges between every co-changed pair were removed because at any real
 * building count they read as a tangle (docs/VISUALIZATION_ROADMAP.md, S6).
 * The relationships did not stop mattering, only drawing *all* of them did.
 * So this overlay draws the relationships of one thing at a time -- the
 * building or district the reader has selected -- where every line has a
 * visible start and a visible end:
 *
 *   import-lines     arcs from a building to the files it imports (blue), from
 *                    the files that import it (amber), and red for an import
 *                    that breaks the layering (analyzer/architecture.py).
 *   cochange-rings   a teal ring on the ground around every file that keeps
 *                    changing in the same commits (the co-change pairs).
 *   impact-rings     the blast radius: a flood-map disc under every file that
 *                    transitively imports the selection, deepest violet one
 *                    hop away and paler for each further hop (to IMPACT_HOPS).
 *   hidden-arcs      dashed violet arcs to the files it keeps changing with
 *                    although neither imports the other (hidden coupling).
 *   clone-links      high cyan arcs to the files that share a copied block of
 *                    code with it (analyzer/clones.py).
 *   district-links   for a district: arcs to the folders it imports and is
 *                    imported by, and teal arcs to the folders it changes with,
 *                    each as thick as the relationship is strong.
 *
 * The overlay is its own scene group, not part of `CityMesh`, so a streaming
 * rebuild does not drop it; it is at most a handful of draw calls and only
 * while something is selected.
 */

import { mergeParts, tag, PART_FIXED } from './primitives.js';

export const LINK_COLOURS = {
  out: 0x4da3ff,
  in: 0xffb347,
  violation: 0xff3b30,
  cochange: 0x2ee6c9,
  hidden: 0xb07cff,
  clone: 0x2fd4e0,
};

const MAX_LINES = 80;
const MAX_RINGS = 60;
const MAX_FLOOD = 160;
// Ground marks sit this far above the district plate (itself 3 cm above the
// plinth). A few centimetres is lost to depth precision at a few hundred
// metres with a 0.5 m near plane, and the mark z-fights into the pavement.
const GROUND_LIFT = 0.3;
// Flood colours by hop: 1 (imports it directly) is the deepest.
export const IMPACT_COLOURS = [0x7b3fe4, 0x9a6cf0, 0xb89af5, 0xd6c6fa];
export const IMPACT_HOPS = IMPACT_COLOURS.length;

/**
 * Every file that transitively imports `id`, with its hop count, nearest
 * first. `importers` is edgeMaps(...).importers; the walk is breadth-first so
 * each file keeps its shortest distance, and stops at `maxHops`.
 */
export function blastRadius(importers, id, maxHops = IMPACT_HOPS) {
  const hops = new Map([[id, 0]]);
  let frontier = [id];
  for (let hop = 1; hop <= maxHops && frontier.length; hop++) {
    const next = [];
    for (const node of frontier) {
      for (const from of importers.get(node) || []) {
        if (hops.has(from)) continue;
        hops.set(from, hop);
        next.push(from);
      }
    }
    frontier = next;
  }
  hops.delete(id);
  return [...hops.entries()];
}

/** A tube along a shallow arc from `a` to `b`, apex proportional to the span. */
function arc(THREE, a, b, radius, lift = 0.22) {
  const span = Math.hypot(b.x - a.x, b.z - a.z);
  const apex = Math.max(a.y, b.y) + Math.max(8, span * lift);
  const mid = new THREE.Vector3((a.x + b.x) / 2, apex, (a.z + b.z) / 2);
  const curve = new THREE.QuadraticBezierCurve3(
    new THREE.Vector3(a.x, a.y, a.z),
    mid,
    new THREE.Vector3(b.x, b.y, b.z)
  );
  const segments = Math.max(12, Math.min(48, Math.round(span / 8)));
  const geometry = new THREE.TubeGeometry(curve, segments, radius, 6, false);
  return tag(geometry, PART_FIXED, 0, 1);
}

/**
 * The same arc as `arc`, cut into dashes: a relationship the code does not
 * declare is drawn as a line that is not quite there.
 */
function dashedArc(THREE, a, b, radius, lift = 0.3) {
  const span = Math.hypot(b.x - a.x, b.z - a.z);
  const apex = Math.max(a.y, b.y) + Math.max(8, span * lift);
  const curve = new THREE.QuadraticBezierCurve3(
    new THREE.Vector3(a.x, a.y, a.z),
    new THREE.Vector3((a.x + b.x) / 2, apex, (a.z + b.z) / 2),
    new THREE.Vector3(b.x, b.y, b.z)
  );
  const dashes = Math.max(6, Math.min(30, Math.round(span / 10)));
  const parts = [];
  for (let i = 0; i < dashes; i++) {
    const t0 = i / dashes;
    const t1 = t0 + 0.6 / dashes;
    const points = [0, 0.5, 1].map((f) => curve.getPoint(t0 + (t1 - t0) * f));
    const piece = new THREE.CatmullRomCurve3(points);
    parts.push(tag(new THREE.TubeGeometry(piece, 3, radius, 5, false), PART_FIXED, 0, 1));
  }
  return parts;
}

/** A small upright cylinder where a line lands, so the end reads from the air. */
function landing(THREE, p, radius) {
  const geometry = new THREE.CylinderGeometry(radius * 2.2, radius * 2.2, 0.6, 10);
  geometry.translate(p.x, p.y + 0.3, p.z);
  return tag(geometry, PART_FIXED, 0, 1);
}

export class SelectionOverlay {
  constructor(THREE, scene) {
    this.THREE = THREE;
    this.group = new THREE.Group();
    this.group.name = 'selection-overlay';
    scene.add(this.group);
    this.hidden = new Set(); // layer names switched off in the City Guide
    this.summary = null;
  }

  clear() {
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    }
    this.summary = null;
  }

  setLayerVisible(name, visible) {
    if (visible) this.hidden.delete(name);
    else this.hidden.add(name);
    for (const child of this.group.children) {
      if (child.name.startsWith(name)) child.visible = visible;
    }
  }

  _mesh(name, parts, colour, opacity = 0.9) {
    if (!parts.length) return null;
    const THREE = this.THREE;
    const material = new THREE.MeshBasicMaterial({
      color: colour,
      transparent: opacity < 1,
      opacity,
      depthWrite: opacity >= 1,
      // Win depth ties with whatever lies flat beneath it.
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    });
    const mesh = new THREE.Mesh(mergeParts(THREE, parts), material);
    mesh.name = name;
    mesh.raycast = () => {};
    mesh.renderOrder = 3;
    mesh.visible = ![...this.hidden].some((layer) => name.startsWith(layer));
    this.group.add(mesh);
    return mesh;
  }

  /**
   * A building's imports and co-change partners.
   *
   * `positionOf(id)` returns the ground point `{x, y, z, width, depth}` of a
   * building, or of its district's centre when that building is not resident
   * (then `approximate: true`), or null when it is unknown.
   */
  showBuilding(building, { outgoing = [], incoming = [], partners = [], impact = [], hidden = [], clones = [], positionOf }) {
    this.clear();
    const THREE = this.THREE;
    const from = positionOf(building.id);
    if (!from) return;
    const radius = Math.max(0.25, Math.min(1.1, Math.max(from.width || 4, from.depth || 4) * 0.035));
    const start = { x: from.x, y: from.y + Math.max(2, (building.height || 4) * 0.5), z: from.z };
    const groups = { out: [], in: [], violation: [] };
    let drawn = 0;
    const add = (kind, id) => {
      if (drawn >= MAX_LINES) return;
      const to = positionOf(id);
      if (!to || (Math.abs(to.x - from.x) < 0.01 && Math.abs(to.z - from.z) < 0.01)) return;
      const end = { x: to.x, y: to.y + (to.approximate ? 0.5 : Math.max(1, (to.height || 4) * 0.5)), z: to.z };
      const [a, b] = kind === 'in' ? [end, start] : [start, end];
      groups[kind].push(arc(THREE, a, b, radius));
      groups[kind].push(landing(THREE, kind === 'in' ? a : b, radius));
      drawn++;
    };
    for (const [id, violates] of outgoing) add(violates ? 'violation' : 'out', id);
    for (const [id, violates] of incoming) add(violates ? 'violation' : 'in', id);
    this._mesh('import-lines-out', groups.out, LINK_COLOURS.out);
    this._mesh('import-lines-in', groups.in, LINK_COLOURS.in);
    this._mesh('import-lines-violation', groups.violation, LINK_COLOURS.violation);

    const rings = [];
    for (const [id] of partners.slice(0, MAX_RINGS)) {
      const at = positionOf(id);
      if (!at || at.approximate) continue;
      const outer = Math.max(at.width || 4, at.depth || 4) * 0.72 + 1.2;
      const geometry = new THREE.RingGeometry(outer - Math.max(0.35, outer * 0.12), outer, 32);
      geometry.rotateX(-Math.PI / 2);
      geometry.translate(at.x, at.y + GROUND_LIFT + 0.04, at.z);
      rings.push(tag(geometry, PART_FIXED, 0, 1));
    }
    this._mesh('cochange-rings', rings, LINK_COLOURS.cochange, 0.85);

    // The flood map: a flat disc under each downstream file. Drawn below the
    // co-change rings, which stay legible on top of it when a file is both.
    const floods = IMPACT_COLOURS.map(() => []);
    let flooded = 0;
    for (const [id, hop] of impact) {
      if (flooded >= MAX_FLOOD) break;
      const at = positionOf(id);
      if (!at || at.approximate || hop < 1) continue;
      // Wider than the plot's half-diagonal, so the flood shows as a halo
      // around the building rather than a disc hidden underneath it.
      const radius = Math.hypot(at.width || 4, at.depth || 4) * 0.5 + 2.4;
      const geometry = new THREE.CircleGeometry(radius, 28);
      geometry.rotateX(-Math.PI / 2);
      geometry.translate(at.x, at.y + GROUND_LIFT, at.z);
      floods[Math.min(hop, IMPACT_HOPS) - 1].push(tag(geometry, PART_FIXED, 0, 1));
      flooded++;
    }
    floods.forEach((parts, i) => this._mesh(`impact-rings-${i + 1}`, parts, IMPACT_COLOURS[i], 0.55 - i * 0.07));
    // Relationships the imports do not show: hidden coupling and copied code.
    const endOf = (id) => {
      const to = positionOf(id);
      if (!to || (Math.abs(to.x - from.x) < 0.01 && Math.abs(to.z - from.z) < 0.01)) return null;
      return { x: to.x, y: to.y + (to.approximate ? 0.5 : Math.max(1, (to.height || 4) * 0.5)), z: to.z };
    };
    const hiddenParts = [];
    for (const [id] of hidden.slice(0, MAX_LINES)) {
      const end = endOf(id);
      if (!end) continue;
      hiddenParts.push(...dashedArc(THREE, start, end, radius * 0.9));
      hiddenParts.push(landing(THREE, end, radius));
    }
    this._mesh('hidden-arcs', hiddenParts, LINK_COLOURS.hidden);
    const cloneParts = [];
    for (const [id] of clones.slice(0, MAX_LINES)) {
      const end = endOf(id);
      if (!end) continue;
      cloneParts.push(arc(THREE, start, end, radius * 1.2, 0.45));
      cloneParts.push(landing(THREE, end, radius * 1.3));
    }
    this._mesh('clone-links', cloneParts, LINK_COLOURS.clone);
    this.summary = {
      kind: 'building', outgoing: outgoing.length, incoming: incoming.length, partners: partners.length, drawn,
      impact: impact.length, flooded, hidden: hidden.length, clones: clones.length,
    };
  }

  /**
   * A district's folder-level relationships. `links` is
   * `[{district, kind: 'out'|'in'|'cochange', weight, violates}]`, weight in
   * edges or shared commits; `centreOf(district)` gives its ground centre.
   */
  showDistrict(district, { links = [], centreOf }) {
    this.clear();
    const THREE = this.THREE;
    const from = centreOf(district);
    if (!from) return;
    const heaviest = Math.max(1, ...links.map((l) => l.weight || 1));
    const groups = { out: [], in: [], violation: [], cochange: [] };
    for (const link of links.slice(0, MAX_LINES)) {
      const to = centreOf(link.district);
      if (!to) continue;
      // Thickness says how strong the relationship is, within a band that
      // stays a line rather than a pipe at any city size.
      const radius = 0.35 + 1.5 * Math.sqrt((link.weight || 1) / heaviest);
      const kind = link.violates ? 'violation' : link.kind;
      const [a, b] = link.kind === 'in' ? [to, from] : [from, to];
      // Co-change arcs fly higher, so they separate from the import arcs
      // between the same two folders.
      groups[kind].push(arc(THREE, a, b, radius, link.kind === 'cochange' ? 0.34 : 0.2));
      groups[kind].push(landing(THREE, link.kind === 'in' ? a : b, radius));
    }
    this._mesh('district-links-out', groups.out, LINK_COLOURS.out);
    this._mesh('district-links-in', groups.in, LINK_COLOURS.in);
    this._mesh('district-links-violation', groups.violation, LINK_COLOURS.violation);
    this._mesh('district-links-cochange', groups.cochange, LINK_COLOURS.cochange, 0.6);
    this.summary = { kind: 'district', links: links.length };
  }
}

/**
 * The plan view's folder arrows: the heaviest folder-to-folder imports, and
 * every folder pair with an import against the layering, drawn flat over the
 * map. Folder level and capped at `MAX_FLOWS`, so the plan shows the shape of
 * the architecture rather than every file edge (the tangle skybridges were
 * removed for). Shown only while the plan view is up; the viewer toggles
 * `group.visible`.
 */
export const MAX_FLOWS = 15;

export function planFlowList(manifest, centreOf) {
  const deps = manifest.dependencies;
  if (!deps || !deps.matrix) return [];
  const violating = new Map((deps.violatingPairs || []).map(([a, b, n]) => [`${a}>${b}`, n]));
  const rows = [...deps.matrix].sort((a, b) => b[2] - a[2]);
  const chosen = rows.slice(0, MAX_FLOWS);
  for (const row of rows.slice(MAX_FLOWS)) if (violating.has(`${row[0]}>${row[1]}`)) chosen.push(row);
  const flows = [];
  for (const [a, b, count] of chosen) {
    const from = centreOf(manifest.districts[a]);
    const to = centreOf(manifest.districts[b]);
    if (!from || !to) continue;
    flows.push({ from, to, weight: count, violates: violating.has(`${a}>${b}`), a, b });
  }
  return flows;
}

export class PlanFlows {
  constructor(THREE, scene) {
    this.THREE = THREE;
    this.group = new THREE.Group();
    this.group.name = 'plan-flows';
    this.group.visible = false;
    this.layerOn = true;
    this.flows = [];
    scene.add(this.group);
  }

  setLayerVisible(name, visible) {
    if (name === 'plan-flows') this.layerOn = visible;
  }

  build(manifest, centreOf, height = 0.6) {
    const THREE = this.THREE;
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    }
    this.flows = planFlowList(manifest, centreOf);
    if (!this.flows.length) return;
    const heaviest = Math.max(1, ...this.flows.map((f) => f.weight));
    const span = Math.max(manifest.bounds[2], manifest.bounds[3]);
    const parts = { out: [], violation: [] };
    for (const flow of this.flows) {
      const { from, to } = flow;
      const dx = to.x - from.x;
      const dz = to.z - from.z;
      const length = Math.hypot(dx, dz);
      if (length < 1) continue;
      // Bend to the right of the direction of travel: A->B and B->A separate.
      const nx = -dz / length;
      const nz = dx / length;
      const bend = length * 0.18;
      // On the ground, drawn over everything (depthTest off): lifted above
      // the skyline instead, perspective would shift each arrow away from
      // the folders it joins, the further from the plan's centre the more.
      const y = Math.max(from.y || 0, to.y || 0) + height;
      const radius = Math.max(0.6, span * 0.0025) * (0.6 + 1.6 * Math.sqrt(flow.weight / heaviest));
      // Stop short of the centres so the arrowhead lands beside the label.
      const trim = Math.min(length * 0.15, span * 0.03);
      const start = new THREE.Vector3(from.x + (dx / length) * trim, y, from.z + (dz / length) * trim);
      const end = new THREE.Vector3(to.x - (dx / length) * trim, y, to.z - (dz / length) * trim);
      const mid = new THREE.Vector3((start.x + end.x) / 2 + nx * bend, y, (start.z + end.z) / 2 + nz * bend);
      const curve = new THREE.QuadraticBezierCurve3(start, mid, end);
      const bucket = flow.violates ? parts.violation : parts.out;
      bucket.push(tag(new THREE.TubeGeometry(curve, 24, radius, 6, false), PART_FIXED, 0, 1));
      const tangent = curve.getTangent(1).normalize();
      const head = new THREE.ConeGeometry(radius * 3.2, radius * 8, 10);
      head.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), tangent));
      head.translate(end.x, end.y, end.z);
      bucket.push(tag(head, PART_FIXED, 0, 1));
    }
    for (const [kind, colour] of [['out', LINK_COLOURS.out], ['violation', LINK_COLOURS.violation]]) {
      if (!parts[kind].length) continue;
      const material = new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.85, depthTest: false });
      const mesh = new THREE.Mesh(mergeParts(THREE, parts[kind]), material);
      mesh.name = `plan-flows-${kind}`;
      mesh.raycast = () => {};
      mesh.renderOrder = 5;
      this.group.add(mesh);
    }
  }

  /** Called every frame: only in the plan view, and only while switched on. */
  sync(inPlan) {
    this.group.visible = Boolean(inPlan && this.layerOn && this.group.children.length);
  }
}
