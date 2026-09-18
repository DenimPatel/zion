/**
 * Day/night: a moving sun, a gradient sky, and the emissive switch.
 *
 * The point of the metaphor is here. At noon the city is lit plainly so the data
 * reads as geometry; at dusk the only things glowing are the documented
 * buildings, so "lit = documented" becomes visible in one glance.
 */

export class SkyRig {
  constructor(THREE, scene, bounds) {
    this.THREE = THREE;
    this.scene = scene;
    this.bounds = bounds;
    this.centre = new THREE.Vector3(
      bounds[0] + bounds[2] / 2,
      0,
      bounds[1] + bounds[3] / 2
    );
    const span = Math.max(bounds[2], bounds[3]);

    this.sun = new THREE.DirectionalLight(0xffffff, 2.1);
    this.sun.castShadow = true;
    const shadowExtent = span * 0.62;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.left = -shadowExtent;
    this.sun.shadow.camera.right = shadowExtent;
    this.sun.shadow.camera.top = shadowExtent;
    this.sun.shadow.camera.bottom = -shadowExtent;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = span * 3.2;
    this.sun.shadow.bias = -0.0006;
    scene.add(this.sun);
    scene.add(this.sun.target);
    this.sun.target.position.copy(this.centre);

    this.hemi = new THREE.HemisphereLight(0xbcd4ff, 0x1b2030, 0.75);
    scene.add(this.hemi);

    this.ambient = new THREE.AmbientLight(0xffffff, 0.22);
    scene.add(this.ambient);

    // A large inverted sphere with a vertical gradient reads as sky and needs
    // no textures.
    this.skyMaterial = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        topColor: { value: new THREE.Color(0x2c4a7c) },
        bottomColor: { value: new THREE.Color(0x0a0e18) },
        offset: { value: 0.0 },
        exponent: { value: 0.7 },
      },
      vertexShader: `
        varying vec3 vWorldPosition;
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          vWorldPosition = world.xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 topColor;
        uniform vec3 bottomColor;
        uniform float offset;
        uniform float exponent;
        varying vec3 vWorldPosition;
        void main() {
          float h = normalize(vWorldPosition + offset).y;
          gl_FragColor = vec4(mix(bottomColor, topColor, max(pow(max(h, 0.0), exponent), 0.0)), 1.0);
        }
      `,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(span * 4.0, 32, 16), this.skyMaterial);
    this.sky.position.copy(this.centre);
    scene.add(this.sky);

    scene.fog = new THREE.Fog(0x0a0e18, span * 0.5, span * 3.4);
    this.setTime(12);
  }

  /** `hour` is 0..24. Returns the night factor, 0 by day and 1 by night. */
  setTime(hour) {
    const THREE = this.THREE;
    const t = ((hour % 24) + 24) % 24;

    // Sun sweeps from east (dawn) over the top (noon) to west (dusk).
    const angle = ((t - 6) / 24) * Math.PI * 2;
    const elevation = Math.sin(angle);
    const distance = Math.max(this.bounds[2], this.bounds[3]) * 1.6 + 120;

    this.sun.position.set(
      this.centre.x + Math.cos(angle) * distance,
      Math.max(-0.25, elevation) * distance * 0.75,
      this.centre.z + Math.sin(angle * 0.5) * distance * 0.35
    );

    // Daylight blend: 0 deep night, 1 full noon.
    const day = Math.max(0, Math.min(1, (elevation + 0.18) / 0.9));
    const dusk = Math.max(0, 1 - Math.abs(elevation) * 3.2);

    const warm = new THREE.Color(0xffb066);
    const noon = new THREE.Color(0xfff6e8);
    this.sun.color.copy(warm).lerp(noon, Math.max(0, Math.min(1, elevation * 1.6)));
    this.sun.intensity = 0.12 + day * 2.1;

    this.hemi.intensity = 0.12 + day * 0.7;
    this.ambient.intensity = 0.06 + day * 0.2;

    const nightSky = new THREE.Color(0x05070f);
    const daySky = new THREE.Color(0x4a76b8);
    const duskSky = new THREE.Color(0x7a4a63);
    const top = nightSky.clone().lerp(daySky, day);
    if (dusk > 0.02 && day < 0.85) {
      top.lerp(duskSky, dusk * 0.45 * (1 - day));
    }
    const bottom = new THREE.Color(0x090c14).lerp(new THREE.Color(0xbba98f), day * 0.55);

    this.skyMaterial.uniforms.topColor.value.copy(top);
    this.skyMaterial.uniforms.bottomColor.value.copy(bottom);
    if (this.scene.fog) this.scene.fog.color.copy(bottom);

    // Windows only matter when it is dark; this is the whole point.
    const nightFactor = 1 - day;
    return nightFactor;
  }

  setShadowQuality(enabled) {
    this.sun.castShadow = enabled;
  }
}
