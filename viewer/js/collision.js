/**
 * Walk mode: gravity, an AABB collision stack on a spatial grid, and a
 * first-person camera that can enter buildings.
 *
 * The grid exists because brute-forcing every building every frame is the one
 * thing that does not survive 50,000 files. Cells are 16 m and each building is
 * registered in every cell its footprint touches, so a step only ever tests the
 * handful of boxes around the player.
 */

const CELL = 16;
const EYE_HEIGHT = 1.7;
const PLAYER_RADIUS = 0.9;
const WALK_SPEED = 9;
const RUN_SPEED = 20;
const GRAVITY = 22;
const JUMP = 8.4;

export class CollisionGrid {
  constructor(placed) {
    this.cells = new Map();
    this.count = 0;
    for (const building of placed) {
      // Parks are walkable; everything else is solid.
      if (building.archetype === 'park') continue;
      const minX = building.x;
      const minZ = building.y;
      const maxX = building.x + (building.width || 4);
      const maxZ = building.y + (building.depth || 4);
      const box = {
        rel: building.rel,
        id: building.id,
        x0: minX,
        z0: minZ,
        x1: maxX,
        z1: maxZ,
        height: building.height || 3,
      };
      this.count++;
      const cx0 = Math.floor(minX / CELL);
      const cx1 = Math.floor(maxX / CELL);
      const cz0 = Math.floor(minZ / CELL);
      const cz1 = Math.floor(maxZ / CELL);
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cz = cz0; cz <= cz1; cz++) {
          const key = `${cx},${cz}`;
          let bucket = this.cells.get(key);
          if (!bucket) {
            bucket = [];
            this.cells.set(key, bucket);
          }
          bucket.push(box);
        }
      }
    }
  }

  /** Register an extra box that is not a file, such as the City Hall landmark. */
  addBox(box) {
    this.count++;
    const cx0 = Math.floor(box.x0 / CELL);
    const cx1 = Math.floor(box.x1 / CELL);
    const cz0 = Math.floor(box.z0 / CELL);
    const cz1 = Math.floor(box.z1 / CELL);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const key = `${cx},${cz}`;
        let bucket = this.cells.get(key);
        if (!bucket) {
          bucket = [];
          this.cells.set(key, bucket);
        }
        bucket.push(box);
      }
    }
  }

  /** Boxes near a point, deduplicated. */
  near(x, z) {
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    const found = [];
    const seen = new Set();
    for (let ix = cx - 1; ix <= cx + 1; ix++) {
      for (let iz = cz - 1; iz <= cz + 1; iz++) {
        const bucket = this.cells.get(`${ix},${iz}`);
        if (!bucket) continue;
        for (const box of bucket) {
          if (seen.has(box)) continue;
          seen.add(box);
          found.push(box);
        }
      }
    }
    return found;
  }

  /** Resolve a proposed position, pushing the player out of any solid box. */
  resolve(x, z, feetY, headY) {
    let px = x;
    let pz = z;
    for (const box of this.near(px, pz)) {
      // Standing on the roof is not a collision with the walls.
      if (feetY >= box.height - 0.05) continue;
      if (headY <= 0) continue;
      const insideX = px > box.x0 - PLAYER_RADIUS && px < box.x1 + PLAYER_RADIUS;
      const insideZ = pz > box.z0 - PLAYER_RADIUS && pz < box.z1 + PLAYER_RADIUS;
      if (!insideX || !insideZ) continue;

      // Push out along the shallowest axis, so the player slides along walls
      // instead of sticking to them.
      const left = Math.abs(px - (box.x0 - PLAYER_RADIUS));
      const right = Math.abs(box.x1 + PLAYER_RADIUS - px);
      const back = Math.abs(pz - (box.z0 - PLAYER_RADIUS));
      const front = Math.abs(box.z1 + PLAYER_RADIUS - pz);
      const smallest = Math.min(left, right, back, front);
      if (smallest === left) px = box.x0 - PLAYER_RADIUS;
      else if (smallest === right) px = box.x1 + PLAYER_RADIUS;
      else if (smallest === back) pz = box.z0 - PLAYER_RADIUS;
      else pz = box.z1 + PLAYER_RADIUS;
    }
    return { x: px, z: pz };
  }

  /** Height of the highest roof directly under a point, or 0 for the street. */
  roofHeight(x, z) {
    let best = 0;
    for (const box of this.near(x, z)) {
      if (x >= box.x0 && x <= box.x1 && z >= box.z0 && z <= box.z1) {
        best = Math.max(best, box.height);
      }
    }
    return best;
  }

  buildingAt(x, z, feetY) {
    for (const box of this.near(x, z)) {
      if (x >= box.x0 && x <= box.x1 && z >= box.z0 && z <= box.z1 && feetY < box.height) {
        return box;
      }
    }
    return null;
  }
}

export class WalkCamera {
  constructor(THREE, camera, grid, bounds) {
    this.THREE = THREE;
    this.camera = camera;
    this.grid = grid;
    this.bounds = bounds;
    this.position = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.vertical = 0;
    this.onGround = true;
    this.enabled = false;
    this.lookSpeed = 0.0022;
    this.keys = new Set();
    this.target = null; // building the player is looking at, for entry

    window.addEventListener('keydown', (event) => this.keys.add(event.code));
    window.addEventListener('keyup', (event) => this.keys.delete(event.code));
    document.addEventListener('mousemove', (event) => {
      if (!this.enabled) return;
      this.yaw -= event.movementX * this.lookSpeed;
      this.pitch -= event.movementY * this.lookSpeed;
      const limit = Math.PI / 2 - 0.02;
      this.pitch = Math.max(-limit, Math.min(limit, this.pitch));
    });
  }

  spawnAt(x, z) {
    this.position.set(x, 0, z);
    this.vertical = 0;
    this.onGround = true;
  }

  /** Enter walk mode at the nearest street position to the current camera. */
  fromFlyingCamera(fly) {
    const ground = Math.max(0, fly.position.y);
    this.position.set(fly.position.x, ground, fly.position.z);
    // Drop the player onto the street if they were above the city.
    const roof = this.grid.roofHeight(this.position.x, this.position.z);
    if (this.position.y < roof + 1.5 && this.position.y > roof) {
      this.position.y = roof;
    } else if (this.position.y > ground) {
      this.position.y = Math.max(0, Math.min(this.position.y, ground));
    }
    this.yaw = fly.yaw;
    this.pitch = Math.max(-1.2, Math.min(0.6, fly.pitch));
    this.vertical = 0;
    // Grounded only if we actually landed on something.
    this.onGround = this.position.y <= this.grid.roofHeight(this.position.x, this.position.z) + 0.01;
  }

  apply() {
    this.camera.position.set(this.position.x, this.position.y + EYE_HEIGHT, this.position.z);
    const cosPitch = Math.cos(this.pitch);
    this.camera.lookAt(
      this.position.x - Math.sin(this.yaw) * cosPitch,
      this.position.y + EYE_HEIGHT + Math.sin(this.pitch),
      this.position.z - Math.cos(this.yaw) * cosPitch
    );
  }

  update(dt) {
    if (!this.enabled) return;
    const THREE = this.THREE;
    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));

    const wish = new THREE.Vector3();
    if (this.keys.has('KeyW')) wish.add(forward);
    if (this.keys.has('KeyS')) wish.sub(forward);
    if (this.keys.has('KeyD')) wish.add(right);
    if (this.keys.has('KeyA')) wish.sub(right);

    const speed = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? RUN_SPEED : WALK_SPEED;
    if (wish.lengthSq() > 0) wish.normalize().multiplyScalar(speed);

    const proposedX = this.position.x + wish.x * dt;
    const proposedZ = this.position.z + wish.z * dt;
    const resolved = this.grid.resolve(
      proposedX,
      proposedZ,
      this.position.y,
      this.position.y + EYE_HEIGHT
    );
    this.position.x = resolved.x;
    this.position.z = resolved.z;

    if (this.keys.has('Space') && this.onGround) {
      this.vertical = JUMP;
      this.onGround = false;
    }

    this.vertical -= GRAVITY * dt;
    this.position.y += this.vertical * dt;

    const roof = this.grid.roofHeight(this.position.x, this.position.z);
    if (this.position.y <= roof) {
      this.position.y = roof;
      this.vertical = 0;
      this.onGround = true;
    } else {
      // Falling is not standing. Without this the player is reported as
      // grounded for the whole fall, which hides the fact that they are still
      // in the air.
      this.onGround = false;
    }

    this.apply();
    this.target = this.grid.buildingAt(this.position.x, this.position.z, this.position.y - 0.5)
      || this._lookAt();
  }

  /** Simple forward probe, so "press E to enter" works while walking. */
  _lookAt() {
    for (let step = 1; step <= 6; step++) {
      const distance = step * 2.5;
      const x = this.position.x - Math.sin(this.yaw) * distance;
      const z = this.position.z - Math.cos(this.yaw) * distance;
      const box = this.grid.buildingAt(x, z, this.position.y);
      if (box) return box;
    }
    return null;
  }
}
