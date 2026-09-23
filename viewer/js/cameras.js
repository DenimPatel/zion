/**
 * Cameras: a 6DOF fly camera and an orbit camera that circles the city.
 *
 * Walk mode (gravity, collision stack against buildings) lives alongside these
 * in `collision.js`; this module owns the free-flight and orbit states.
 *
 * The two hand over to each other rather than cutting. Switching used to snap
 * the view to a fixed vantage and switching back dropped you somewhere else
 * entirely, which is disorienting in a city with no landmarks but its own
 * buildings -- you lose track of where you were looking. `adopt` and `handOff`
 * mean the picture on screen never jumps: only who is driving it changes.
 */

export class FlyCamera {
  constructor(THREE, camera, bounds) {
    this.THREE = THREE;
    this.camera = camera;
    this.bounds = bounds;
    this.position = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = -0.22;

    // Speed is a property of the city, not a constant.
    //
    // A fixed 42 m/s is brisk in a 28-file city and close to useless in a
    // 3,200 m one, where the opening camera sits four kilometres out: holding
    // W for a minute and a half to reach the buildings is the single thing
    // that made flying feel broken. Both the base speed and the altitude
    // response below are derived from the plan's own span.
    const span = Math.max(bounds[2], bounds[3]);
    this.speed = Math.min(200, Math.max(16, span * 0.035));
    // The altitude at which you travel at exactly `speed`; above it you cover
    // ground faster, below it you slow down for close work. This is why a map
    // feels right to fly and a fixed-speed camera does not -- the scale you are
    // working at is legible from how high you are.
    this.reference = Math.max(25, span * 0.035);
    this.boost = 2.6;   // Shift
    this.crawl = 0.25;  // Alt or Ctrl, for threading between towers
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

  }

  /**
   * Apply a look delta in pixels.
   *
   * The viewer owns the pointer events and calls this, rather than the camera
   * listening to the document: looking must only happen while the user is
   * deliberately dragging or has explicitly captured the mouse, never as a side
   * effect of moving the cursor across the page.
   */
  lookDelta(dx, dy) {
    if (!this.enabled) return;
    this.yaw -= dx * this.lookSpeed;
    this.pitch -= dy * this.lookSpeed;
    const limit = Math.PI / 2 - 0.02;
    this.pitch = Math.max(-limit, Math.min(limit, this.pitch));
  }

  /**
   * Metres per second right now: the base speed scaled by how high you are and
   * by whichever modifier is held.
   */
  currentSpeed() {
    const altitude = Math.max(0, this.position.y) / this.reference;
    const scale = Math.min(4.5, Math.max(0.45, altitude));
    let speed = this.speed * scale;
    if (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')) speed *= this.boost;
    if (this.keys.has('AltLeft') || this.keys.has('AltRight') ||
        this.keys.has('ControlLeft') || this.keys.has('ControlRight')) speed *= this.crawl;
    return speed;
  }

  /**
   * Move along the view direction, for the mouse wheel.
   *
   * Wheel-to-dolly is the one control every 3D viewer has and this one did not,
   * so a mouse alone could turn the camera but never take it anywhere.
   */
  dolly(notches) {
    if (!this.enabled || !notches) return;
    const step = this.currentSpeed() * 0.35 * notches;
    const cosPitch = Math.cos(this.pitch);
    this.position.x -= Math.sin(this.yaw) * cosPitch * step;
    this.position.y += Math.sin(this.pitch) * step;
    this.position.z -= Math.cos(this.yaw) * cosPitch * step;
    this.clamp();
    this.apply();
  }

  /** Keep the camera above the ground and inside a generous envelope. */
  clamp() {
    this.position.y = Math.max(1.2, this.position.y);
    const [bx, bz, bw, bh] = this.bounds;
    const margin = Math.max(bw, bh) * 1.5 + 200;
    this.position.x = Math.max(bx - margin, Math.min(bx + bw + margin, this.position.x));
    this.position.z = Math.max(bz - margin, Math.min(bz + bh + margin, this.position.z));
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

    this.velocity.lerp(wish.multiplyScalar(this.currentSpeed()), Math.min(1, dt * 9));
    this.position.addScaledVector(this.velocity, dt);
    this.clamp();
    this.apply();
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
  }
}

/**
 * Orbit: circle the city, and stop wherever you like.
 *
 * A city is a shape, and a shape has sides. Free flight can get you to any of
 * them but only by steering there, which is work, and in a repository whose
 * districts all look broadly alike it is easy to fly a full lap without
 * realising you have. So this camera does the lap for you: it swings around a
 * target at a fixed radius, and every other control stops it dead at the
 * bearing it has reached rather than fighting it. Start it, watch, stop where
 * it looks right, then drag, zoom or pan from there -- or press O again and
 * fly off from exactly that vantage.
 *
 * Its target is a point, not the city: focus it on a building or a district and
 * the same circle inspects that instead.
 */
export class OrbitCamera {
  constructor(THREE, camera, bounds) {
    this.THREE = THREE;
    this.camera = camera;
    this.bounds = bounds;
    const span = Math.max(bounds[2], bounds[3]);

    this.target = new THREE.Vector3(
      bounds[0] + bounds[2] / 2,
      0,
      bounds[1] + bounds[3] / 2
    );
    this.distance = span * 0.95;
    this.azimuth = 0;          // 0 is due south of the target, growing clockwise
    this.elevation = 0.42;     // radians above the horizon
    // A full lap in a little under a minute: slow enough to read a facade as it
    // goes by, fast enough that you are not waiting on the far side.
    this.spinSpeed = 0.115;
    this.spinning = false;
    this.minDistance = Math.max(12, span * 0.02);
    this.maxDistance = span * 3.0;
    this._active = false;
  }

  get active() {
    return this._active;
  }

  set active(value) {
    this._active = value;
  }

  /**
   * Take over from the fly camera without moving the picture.
   *
   * The orbit target is whatever the fly camera was looking at -- found by
   * dropping its view ray onto the ground -- so pressing O starts the circle
   * around the thing you were already studying rather than teleporting you to
   * a canned vantage of the whole plan.
   */
  adopt(fly) {
    const pitch = fly.pitch;
    const cosPitch = Math.cos(pitch);
    const dir = {
      x: -Math.sin(fly.yaw) * cosPitch,
      y: Math.sin(pitch),
      z: -Math.cos(fly.yaw) * cosPitch,
    };
    const span = Math.max(this.bounds[2], this.bounds[3]);
    // Looking level or up has no ground intersection to speak of, so fall back
    // to a point a sensible distance ahead.
    const reach = dir.y < -0.05
      ? Math.min(span * 1.5, fly.position.y / -dir.y)
      : span * 0.5;
    this.target.set(
      fly.position.x + dir.x * reach,
      0,
      fly.position.z + dir.z * reach
    );
    this._clampTarget();

    const dx = fly.position.x - this.target.x;
    const dy = fly.position.y - this.target.y;
    const dz = fly.position.z - this.target.z;
    this.distance = Math.min(
      this.maxDistance,
      Math.max(this.minDistance, Math.hypot(dx, dy, dz))
    );
    this.azimuth = Math.atan2(dx, dz);
    this.elevation = Math.asin(Math.max(-1, Math.min(1, dy / Math.max(this.distance, 1e-6))));
    this._clampElevation();
    this.apply();
  }

  /** Hand the current vantage back to the fly camera, again without a cut. */
  handOff(fly) {
    fly.position.copy(this.camera.position);
    const dx = this.target.x - fly.position.x;
    const dy = this.target.y - fly.position.y;
    const dz = this.target.z - fly.position.z;
    fly.yaw = Math.atan2(-dx, -dz);
    fly.pitch = Math.atan2(dy, Math.hypot(dx, dz));
    fly.velocity.set(0, 0, 0);
    fly.clamp();
    fly.apply();
  }

  /** Frame the whole plan, keeping whatever bearing the camera already has. */
  frame(bounds) {
    this.bounds = bounds;
    const [bx, bz, bw, bh] = bounds;
    const span = Math.max(bw, bh);
    this.target.set(bx + bw / 2, 0, bz + bh / 2);
    this.distance = span * 0.95;
    this.elevation = 0.42;
    this.maxDistance = span * 3.0;
    this.apply();
  }

  /**
   * Circle one thing instead of the whole city.
   *
   * `radius` is the size of what is being looked at, so a 6 m file and a 400 m
   * district both end up filling a similar share of the frame.
   */
  focusOn(point, radius, height = 0) {
    this.target.set(point.x, height, point.z);
    this.distance = Math.min(
      this.maxDistance,
      Math.max(this.minDistance, radius * 3.2)
    );
    this.elevation = 0.38;
    this.apply();
  }

  toggleSpin() {
    this.spinning = !this.spinning;
    return this.spinning;
  }

  /**
   * Drag to swing around the target.
   *
   * Any manual input stops the automatic lap. That is the "stop anywhere" half
   * of the feature: you never have to find a pause button, you just touch the
   * controls and the camera is yours from wherever it had got to.
   */
  orbitDelta(dx, dy) {
    this.spinning = false;
    this.azimuth -= dx * 0.005;
    this.elevation += dy * 0.004;
    this._clampElevation();
    this.apply();
  }

  /** Right-drag: slide the target across the ground, in screen axes. */
  panDelta(dx, dy) {
    this.spinning = false;
    // Scale with distance so a pan covers the same fraction of the screen
    // whether you are on the skyline or between two towers.
    const scale = this.distance * 0.0016;
    const sin = Math.sin(this.azimuth);
    const cos = Math.cos(this.azimuth);
    this.target.x -= (dx * cos - dy * sin) * scale;
    this.target.z += (dx * sin + dy * cos) * scale;
    this._clampTarget();
    this.apply();
  }

  /** Wheel: in and out along the orbit radius. */
  zoomBy(notches) {
    if (!notches) return;
    this.distance = Math.min(
      this.maxDistance,
      Math.max(this.minDistance, this.distance * Math.pow(0.86, notches))
    );
    this.apply();
  }

  /** Nudge the bearing by keyboard, which also stops the lap. */
  nudge({ azimuth = 0, elevation = 0, distance = 1 }) {
    if (azimuth || elevation) this.spinning = false;
    this.azimuth += azimuth;
    this.elevation += elevation;
    this._clampElevation();
    if (distance !== 1) {
      this.distance = Math.min(
        this.maxDistance,
        Math.max(this.minDistance, this.distance * distance)
      );
      this.spinning = false;
    }
    this.apply();
  }

  _clampElevation() {
    // Never quite level with the ground and never quite overhead: both ends
    // degenerate, and the top one makes the azimuth meaningless on screen.
    this.elevation = Math.max(0.04, Math.min(1.45, this.elevation));
  }

  _clampTarget() {
    const [bx, bz, bw, bh] = this.bounds;
    const margin = Math.max(bw, bh) * 0.6;
    this.target.x = Math.max(bx - margin, Math.min(bx + bw + margin, this.target.x));
    this.target.z = Math.max(bz - margin, Math.min(bz + bh + margin, this.target.z));
  }

  apply() {
    const cosElevation = Math.cos(this.elevation);
    this.camera.position.set(
      this.target.x + this.distance * cosElevation * Math.sin(this.azimuth),
      // Above the ground whatever the elevation and radius work out to, so a
      // low orbit skims the skyline instead of burrowing under it.
      Math.max(2, this.target.y + this.distance * Math.sin(this.elevation)),
      this.target.z + this.distance * cosElevation * Math.cos(this.azimuth)
    );
    this.camera.lookAt(this.target);
  }

  update(dt) {
    if (!this._active) return;
    if (this.spinning) this.azimuth += dt * this.spinSpeed;
    this.apply();
  }
}

/**
 * Plan view: the city read as a map, straight down, north up.
 *
 * An oblique camera is how you *look at* a city; a plan is how you *read* it --
 * every district is its true shape, nothing hides behind a tower, and the roads
 * say how the folders nest. The camera sits exactly overhead, so its rotation
 * is set directly rather than through `lookAt`, which has no defined "up" when
 * the view direction is vertical. Panning moves the ground point under the
 * camera; zooming changes the height.
 */
export class TopCamera {
  constructor(THREE, camera, bounds, skyline = 0) {
    this.THREE = THREE;
    this.camera = camera;
    // A long lens: at 60 degrees the towers under the camera lean out of the
    // frame and hide their neighbours; at 28 the plan reads like a map. The
    // viewer eases the camera's fov toward this while the plan is active.
    this.fov = 28;
    this.skyline = skyline;
    this.target = new THREE.Vector3();
    this.keys = new Set();
    this.setBounds(bounds);
    this.height = this.maxHeight * 0.6;
    this.target.set(bounds[0] + bounds[2] / 2, 0, bounds[1] + bounds[3] / 2);
    this._active = false;
    this._onKeyDown = (event) => {
      if (event.repeat) return;
      this.keys.add(event.code);
    };
    this._onKeyUp = (event) => this.keys.delete(event.code);
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
  }

  setBounds(bounds) {
    this.bounds = bounds;
    const span = Math.max(bounds[2], bounds[3]);
    // Never low enough for the tallest tower to reach the lens.
    this.minHeight = Math.max(30, span * 0.08, (this.skyline || 0) * 1.15 + 20);
    // High enough that the whole plan fits a 60 degree frustum with margin.
    this.maxHeight = Math.max(this.minHeight * 2, span * 3.4);
  }

  get active() {
    return this._active;
  }

  set active(value) {
    this._active = value;
    if (!value) this.keys.clear();
  }

  /** The height at which the whole plan fills the frame. */
  frameHeight() {
    const [, , bw, bh] = this.bounds;
    const fov = (this.fov * Math.PI) / 180;
    const aspect = this.camera.aspect || 1;
    const fitDepth = bh / 2 / Math.tan(fov / 2);
    const fitWidth = bw / 2 / (Math.tan(fov / 2) * aspect);
    return Math.min(this.maxHeight, Math.max(this.minHeight, Math.max(fitDepth, fitWidth) * 1.08));
  }

  /** Frame the whole plan. */
  frame() {
    const [bx, bz, bw, bh] = this.bounds;
    this.target.set(bx + bw / 2, 0, bz + bh / 2);
    this.height = this.frameHeight();
    this.apply();
  }

  /**
   * Take over from the fly camera: the plan is centred on the ground point the
   * fly camera was looking at, at a height that keeps roughly the same scale.
   */
  adopt(fly) {
    const cosPitch = Math.cos(fly.pitch);
    const dir = { x: -Math.sin(fly.yaw) * cosPitch, y: Math.sin(fly.pitch), z: -Math.cos(fly.yaw) * cosPitch };
    const span = Math.max(this.bounds[2], this.bounds[3]);
    const reach = dir.y < -0.05 ? Math.min(span * 1.5, fly.position.y / -dir.y) : span * 0.25;
    this.target.set(fly.position.x + dir.x * reach, 0, fly.position.z + dir.z * reach);
    this.height = this.frameHeight() * 0.6;
    this._clamp();
  }

  /** The pose `adopt` settles on, for an animated hand-over. */
  pose() {
    const THREE = this.THREE;
    const position = new THREE.Vector3(this.target.x, this.height, this.target.z);
    const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0, 'YXZ'));
    return { position, quaternion };
  }

  /** Hand the vantage back to the fly camera, looking (almost) straight down. */
  handOff(fly) {
    fly.position.copy(this.camera.position);
    fly.yaw = 0;
    fly.pitch = -(Math.PI / 2 - 0.02);
    fly.velocity.set(0, 0, 0);
    fly.clamp();
    fly.apply();
  }

  /** Centre the plan on a ground point, keeping the height. */
  centreOn(x, z) {
    this.target.x = x;
    this.target.z = z;
    this._clamp();
    this.apply();
  }

  /** Metres of ground per screen pixel at the current height. */
  metresPerPixel(viewportHeight) {
    const fov = ((this.camera.fov || this.fov) * Math.PI) / 180;
    return (2 * this.height * Math.tan(fov / 2)) / Math.max(1, viewportHeight);
  }

  /** Drag: the ground follows the pointer, like dragging a paper map. */
  panDelta(dx, dy, viewportHeight) {
    const scale = this.metresPerPixel(viewportHeight);
    this.target.x -= dx * scale;
    this.target.z -= dy * scale;
    this._clamp();
    this.apply();
  }

  /** Wheel: lower or raise the camera, geometrically so each notch feels the same. */
  zoomBy(notches) {
    if (!notches) return;
    this.height *= Math.pow(0.86, notches);
    this._clamp();
    this.apply();
  }

  /** The ground rectangle currently on screen: [x, z, w, h]. */
  visibleRect() {
    const fov = ((this.camera.fov || this.fov) * Math.PI) / 180;
    const h = 2 * this.height * Math.tan(fov / 2);
    const w = h * (this.camera.aspect || 1);
    return [this.target.x - w / 2, this.target.z - h / 2, w, h];
  }

  _clamp() {
    this.height = Math.min(this.maxHeight, Math.max(this.minHeight, this.height));
    const [bx, bz, bw, bh] = this.bounds;
    const margin = Math.max(bw, bh) * 0.25;
    this.target.x = Math.max(bx - margin, Math.min(bx + bw + margin, this.target.x));
    this.target.z = Math.max(bz - margin, Math.min(bz + bh + margin, this.target.z));
  }

  apply() {
    const { position, quaternion } = this.pose();
    this.camera.position.copy(position);
    this.camera.quaternion.copy(quaternion);
  }

  update(dt) {
    if (!this._active) return;
    let x = 0;
    let z = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) z -= 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) z += 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) x += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) x -= 1;
    if (this.keys.has('KeyE')) this.height *= Math.pow(0.4, dt);
    if (this.keys.has('KeyQ')) this.height *= Math.pow(2.5, dt);
    if (x || z) {
      // A screen-height of ground every ~1.4 s, whatever the zoom.
      let speed = this.height * 0.8;
      if (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')) speed *= 2.6;
      if (this.keys.has('AltLeft') || this.keys.has('AltRight')) speed *= 0.25;
      const length = Math.hypot(x, z);
      this.target.x += (x / length) * speed * dt;
      this.target.z += (z / length) * speed * dt;
    }
    this._clamp();
    this.apply();
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
  }
}

/** Smoothly fly the camera to a point of interest (used by the City Hall table). */
export class CameraFlight {
  constructor(camera) {
    this.camera = camera;
    this.active = false;
  }

  start(fromPosition, fromQuaternion, toPosition, toTarget, duration = 1.4) {
    const look = new this.camera.constructor();
    look.position.copy(toPosition);
    look.lookAt(toTarget);
    this.startPose(fromPosition, fromQuaternion, toPosition, look.quaternion, duration);
  }

  /** As `start`, to an explicit orientation (a straight-down view has no lookAt). */
  startPose(fromPosition, fromQuaternion, toPosition, toQuaternion, duration = 1.4) {
    this.active = true;
    this.elapsed = 0;
    this.duration = duration;
    this.fromPosition = fromPosition.clone();
    this.fromQuaternion = fromQuaternion.clone();
    this.toPosition = toPosition.clone();
    this.toQuaternion = toQuaternion.clone();
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
