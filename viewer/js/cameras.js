/**
 * Cameras: a 6DOF fly camera and a top-down overview.
 *
 * Walk mode (gravity, collision stack against buildings) lives alongside these
 * in `collision.js`; this module owns the free-flight and overview states.
 */

const UP = { x: 0, y: 1, z: 0 };

export class FlyCamera {
  constructor(THREE, camera, bounds) {
    this.THREE = THREE;
    this.camera = camera;
    this.bounds = bounds;
    this.position = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = -0.22;
    this.speed = 42;
    this.boost = 3.4;
    this.lookSpeed = 0.0022;
    this.enabled = false;
    this.onGround = false;

    this.keys = new Set();
    this.velocity = new THREE.Vector3();

    this._onKeyDown = (event) => {
      if (event.repeat) return;
      this.keys.add(event.code);
    };
    this._onKeyUp = (event) => this.keys.delete(event.code);
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);

    this._onMouseMove = (event) => {
      if (!this.enabled) return;
      this.yaw -= event.movementX * this.lookSpeed;
      this.pitch -= event.movementY * this.lookSpeed;
      const limit = Math.PI / 2 - 0.02;
      this.pitch = Math.max(-limit, Math.min(limit, this.pitch));
    };
    document.addEventListener('mousemove', this._onMouseMove);
  }

  setFromManifest(cameraSpec) {
    const [ex, ey, ez] = cameraSpec.eye;
    const [tx, ty, tz] = cameraSpec.target;
    this.position.set(ex, ey, ez);
    const dx = tx - ex;
    const dy = ty - ey;
    const dz = tz - ez;
    this.yaw = Math.atan2(-dx, -dz);
    // Derive pitch from the framing the manifest asked for rather than
    // hardcoding it, so a flat city and a skyscraper city both frame well.
    const horizontal = Math.hypot(dx, dz);
    this.pitch = Math.atan2(dy, horizontal);
    this.apply();
  }

  requestPointerLock(canvas) {
    if (document.pointerLockElement === canvas) return;
    canvas.requestPointerLock?.();
  }

  apply() {
    this.camera.position.copy(this.position);
    const cosPitch = Math.cos(this.pitch);
    this.camera.lookAt(
      this.position.x - Math.sin(this.yaw) * cosPitch,
      this.position.y + Math.sin(this.pitch),
      this.position.z - Math.cos(this.yaw) * cosPitch
    );
  }

  update(dt) {
    if (!this.enabled) return;
    const THREE = this.THREE;
    const forward = new THREE.Vector3(
      -Math.sin(this.yaw),
      0,
      -Math.cos(this.yaw)
    );
    const right = new THREE.Vector3(
      Math.cos(this.yaw),
      0,
      -Math.sin(this.yaw)
    );

    const wish = new THREE.Vector3();
    if (this.keys.has('KeyW')) wish.add(forward);
    if (this.keys.has('KeyS')) wish.sub(forward);
    if (this.keys.has('KeyD')) wish.add(right);
    if (this.keys.has('KeyA')) wish.sub(right);
    if (this.keys.has('KeyE') || this.keys.has('Space')) wish.y += 1;
    if (this.keys.has('KeyQ')) wish.y -= 1;
    if (wish.lengthSq() > 0) wish.normalize();

    const speed = this.speed * (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? this.boost : 1);
    this.velocity.lerp(wish.multiplyScalar(speed), Math.min(1, dt * 9));
    this.position.addScaledVector(this.velocity, dt);

    // Keep the camera above the ground and inside a generous envelope.
    this.position.y = Math.max(1.2, this.position.y);
    const [bx, bz, bw, bh] = this.bounds;
    const margin = Math.max(bw, bh) * 1.5 + 200;
    this.position.x = Math.max(bx - margin, Math.min(bx + bw + margin, this.position.x));
    this.position.z = Math.max(bz - margin, Math.min(bz + bh + margin, this.position.z));

    this.apply();
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    document.removeEventListener('mousemove', this._onMouseMove);
  }
}

export class OverviewCamera {
  constructor(THREE, camera, bounds) {
    this.THREE = THREE;
    this.camera = camera;
    const [bx, bz, bw, bh] = bounds;
    const span = Math.max(bw, bh);
    this.position = new THREE.Vector3(bx + bw / 2, span * 1.05, bz + bh + span * 0.55);
    this.target = new THREE.Vector3(bx + bw / 2, 0, bz + bh / 2);
    this.spin = 0;
  }

  get active() {
    return this._active;
  }

  set active(value) {
    this._active = value;
  }

  update(dt) {
    if (!this._active) return;
    this.spin += dt * 0.04;
    const [bx, bz, bw, bh] = this._bounds || [0, 0, 1, 1];
    this.camera.position.lerp(this.position, Math.min(1, dt * 2.4));
    this.camera.lookAt(this.target);
  }

  frame(bounds) {
    this._bounds = bounds;
    const [bx, bz, bw, bh] = bounds;
    const span = Math.max(bw, bh);
    this.position.set(bx + bw / 2, span * 1.05, bz + bh / 2 + span * 0.72);
    this.target.set(bx + bw / 2, 0, bz + bh / 2);
  }
}

/** Smoothly fly the camera to a point of interest (used by the City Hall table). */
export class CameraFlight {
  constructor(camera) {
    this.camera = camera;
    this.active = false;
  }

  start(fromPosition, fromQuaternion, toPosition, toTarget, duration = 1.4) {
    this.active = true;
    this.elapsed = 0;
    this.duration = duration;
    this.fromPosition = fromPosition.clone();
    this.fromQuaternion = fromQuaternion.clone();
    const look = new this.camera.constructor();
    look.position.copy(toPosition);
    look.lookAt(toTarget);
    this.toPosition = toPosition.clone();
    this.toQuaternion = look.quaternion.clone();
  }

  update(dt) {
    if (!this.active) return false;
    this.elapsed += dt;
    const raw = Math.min(1, this.elapsed / this.duration);
    const eased = raw < 0.5 ? 2 * raw * raw : 1 - Math.pow(-2 * raw + 2, 2) / 2;
    this.camera.position.lerpVectors(this.fromPosition, this.toPosition, eased);
    this.camera.quaternion.slerpQuaternions(
      this.fromQuaternion,
      this.toQuaternion,
      eased
    );
    if (raw >= 1) {
      this.active = false;
      return true;
    }
    return false;
  }
}
