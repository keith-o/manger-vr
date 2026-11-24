import * as THREE from 'three';
import { SplatEdit, SplatEditSdf, SplatEditRgbaBlendMode, SplatEditSdfType } from '@sparkjsdev/spark';

// Oil lamps, each driven by one flicker signal (public/chisel/lights.json lists them):
//  - flame: "baked" lamps have a real flame in the splat, so those splats are made to
//    flicker and sway in place. "drawn" lamps (the wall niches) have only an empty dish in
//    the splat, so a small soft flame is drawn sitting in the dish;
//  - light: the splats around each flame brighten and dim and the lit patch drifts a few
//    centimeters, which also makes the splat's own shimmer read as firelight.
// Positions were measured on the splat itself (the dish rim or the baked flame core).

// Baked flame: splats within this radius of the flame core (fading over the soft edge).
const BAKED_RADIUS = 0.045;
const BAKED_SOFT_EDGE = 0.03;
// Baked flame brightness swing (0.3 = ±30%), and how far it sways and lifts (m).
const BAKED_FLICKER = 0.3;
const BAKED_SWAY_M = 0.012;
const BAKED_LIFT_M = 0.01;

// Drawn flame size (m), like a real oil-lamp wick flame; the quad is taller so the flame
// can stretch up when it flares.
const DRAWN_WIDTH = 0.03;
const DRAWN_HEIGHT = 0.055;
const DRAWN_QUAD_OVERSIZE = 1.6;
// How much its height follows the flicker, and how far the tip leans with the sway.
const DRAWN_STRETCH = 0.35;
const DRAWN_LEAN = 0.08;
// Soft bloom around a drawn flame.
const BLOOM_SIZE = 0.12;
const BLOOM_STRENGTH = 0.5;
// Niche walls hide the flame when seen from the side: fully visible when looking within
// about 70° of straight into the niche, gone by about 80°.
const SIDE_HIDE_FROM = 0.35, SIDE_HIDE_TO = 0.17; // cosine of the viewing angle

// Light pool: full effect within LIGHT_RADIUS of the flame, fading out over LIGHT_SOFT_EDGE.
const LIGHT_RADIUS = 0.4;
const LIGHT_SOFT_EDGE = 1.4;
// How far the pool's brightness swings (0.15 = ±15%). Bigger swings over the whole pool
// at once read as a strobe rather than a flame.
const LIGHT_FLICKER = 0.15;
// How far the pool of light drifts as the flame sways (m).
const LIGHT_SWAY_M = 0.04;
// Brighter moments lean warm: red swings fully, green less, blue least.
const WARM_TINT = [1, 0.8, 0.55];

// Flicker is smooth noise, not sine waves: two layers (per second), kept under ~5 Hz so
// it stays smooth at the frame rates the Quest manages with the splat.
const FLICKER_RATES = [2.2, 5.0];
const FLICKER_WEIGHTS = [0.65, 0.35];
const SWAY_RATE = 1.6;
// Now and then a flame gutters, as if in a draft: a brief, smooth dip.
// A slow sine raised to a high power is near zero most of the time and peaks briefly.
const GUST_HZ = 0.11;
const GUST_SHARPNESS = 12;
const GUST_DIP = 0.25;

// Baked light to remove: per-channel color multiplier inside, and the falloff around it.
// The glow is near-white on brown beams; scaling all channels equally leaves it gray, so
// this is roughly beam-brown divided by glow-white.
const DARKEN_TO = [0.5, 0.33, 0.2];
const DARKEN_RADIUS = 0.6;
const DARKEN_SOFT_EDGE = 0.9;

const flameVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;
// A soft teardrop with no outline: brightness and opacity fall off smoothly from a
// near-white core, through yellow, to a faint orange fringe that fades to nothing.
const flameFragment = /* glsl */ `
  uniform float uTime, uSeed, uHeight, uLean, uBrightness, uVisible, uOversize;
  varying vec2 vUv;
  void main() {
    float y = vUv.y * uOversize / uHeight;
    float yc = clamp(y, 0.0, 1.0);
    float wobble = sin(y * 7.0 - uTime * 6.0 + uSeed) * 0.025 * y;
    float x = vUv.x - 0.5 - (uLean + wobble) * y * y;
    float halfWidth = 0.42 * sin(3.14159 * pow(yc, 0.5)) * (1.0 - 0.25 * yc) + 1e-3;
    float r = abs(x) / halfWidth;
    float glow = exp(-r * r * 2.2) * smoothstep(1.05, 0.55, y) * smoothstep(0.0, 0.12, y);
    float core = exp(-r * r * 6.0) * smoothstep(0.75, 0.15, y) * smoothstep(0.02, 0.2, y);
    vec3 color = mix(vec3(1.0, 0.55, 0.15), vec3(1.0, 0.85, 0.5), glow);
    color = mix(color, vec3(1.0, 0.98, 0.92), core);
    gl_FragColor = vec4(color, clamp(glow * 0.85 + core, 0.0, 1.0) * uBrightness * uVisible);
  }`;

// Smooth 1D value noise in [-1, 1].
function hash(n) {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return (s - Math.floor(s)) * 2 - 1;
}
function noise(x) {
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  return hash(i) * (1 - u) + hash(i + 1) * u;
}

const warm = (sdf, intensity) => {
  const d = intensity - 1;
  sdf.color.setRGB(1 + d * WARM_TINT[0], 1 + d * WARM_TINT[1], 1 + d * WARM_TINT[2]);
};

function bloomTexture() {
  const size = 64;
  const canvas = Object.assign(document.createElement('canvas'), { width: size, height: size });
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,200,120,0.9)');
  g.addColorStop(0.3, 'rgba(255,160,70,0.3)');
  g.addColorStop(1, 'rgba(255,120,40,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// eye(target) writes the viewer's world position into target.
// markers: tint light pools green and darkened spots red (static).
// flameTest: lift each baked flame region 12 cm and tint it blue (static), to check placement.
export async function addLamps(splat, scene, { eye, markers = false, flameTest = false }) {
  const config = await (await fetch('./chisel/lights.json')).json();
  const region = (position, radius, softEdge) => {
    const edit = new SplatEdit({ rgbaBlendMode: SplatEditRgbaBlendMode.MULTIPLY, softEdge });
    const sdf = new SplatEditSdf({ type: SplatEditSdfType.SPHERE, radius });
    sdf.position.fromArray(position);
    edit.addSdf(sdf);
    splat.add(edit);
    return sdf;
  };

  const flameGeometry = new THREE.PlaneGeometry(DRAWN_WIDTH, DRAWN_HEIGHT * DRAWN_QUAD_OVERSIZE);
  flameGeometry.translate(0, (DRAWN_HEIGHT * DRAWN_QUAD_OVERSIZE) / 2, 0);
  const bloom = bloomTexture();

  const lamps = config.lamps.map((lamp, i) => {
    const seed = i * 2.399; // golden-angle offsets keep lamps out of step
    const base = new THREE.Vector3(...lamp.position);
    // A drawn flame's position is its base on the dish; its light comes from a little above.
    const center = lamp.flame === 'drawn' ? base.clone().add(new THREE.Vector3(0, DRAWN_HEIGHT * 0.5, 0)) : base.clone();
    const entry = { seed, base, center, light: region(center.toArray(), LIGHT_RADIUS, LIGHT_SOFT_EDGE) };

    if (lamp.flame === 'baked') {
      entry.baked = region(lamp.position, BAKED_RADIUS, BAKED_SOFT_EDGE);
      return entry;
    }

    // Drawn after the splat and without depth (the splat writes none).
    entry.facing = new THREE.Vector3(...(lamp.facing ?? [0, 0, 1])).normalize();
    entry.drawn = new THREE.Mesh(flameGeometry, new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 }, uSeed: { value: seed }, uHeight: { value: 1 }, uLean: { value: 0 },
        uBrightness: { value: 1 }, uVisible: { value: 1 }, uOversize: { value: DRAWN_QUAD_OVERSIZE },
      },
      vertexShader: flameVertex,
      fragmentShader: flameFragment,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    }));
    entry.drawn.position.copy(base);
    entry.drawn.renderOrder = 10000;
    scene.add(entry.drawn);
    entry.bloom = new THREE.Sprite(new THREE.SpriteMaterial({
      map: bloom, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    entry.bloom.scale.setScalar(BLOOM_SIZE);
    entry.bloom.position.copy(base).y += DRAWN_HEIGHT * 0.35;
    entry.bloom.renderOrder = 9999;
    scene.add(entry.bloom);
    return entry;
  });

  const darkened = config.darken.map((spot) => {
    const sdf = region(spot.position, DARKEN_RADIUS, DARKEN_SOFT_EDGE);
    sdf.color.setRGB(...DARKEN_TO);
    return sdf;
  });

  const debug = markers || flameTest;
  if (markers) {
    for (const { light } of lamps) light.color.setRGB(0.4, 1.2, 0.4);
    for (const sdf of darkened) sdf.color.setRGB(1.2, 0.3, 0.3);
  }
  if (flameTest) {
    for (const { baked } of lamps) {
      if (!baked) continue;
      baked.color.setRGB(0.3, 0.5, 1.5);
      baked.displace.set(0, 0.12, 0);
    }
  }

  const eyePos = new THREE.Vector3(), toEye = new THREE.Vector3();

  return function update(seconds) {
    eye(eyePos);
    for (const lamp of lamps) {
      const s = lamp.seed;
      let flicker = 0;
      FLICKER_RATES.forEach((rate, k) => (flicker += FLICKER_WEIGHTS[k] * noise(seconds * rate + s * (17.3 + k * 14.4))));
      const gust = Math.max(0, Math.sin(seconds * GUST_HZ * Math.PI * 2 + s * 7)) ** GUST_SHARPNESS;
      const swayX = noise(seconds * SWAY_RATE + s * 53.1), swayZ = noise(seconds * SWAY_RATE + s * 71.9);

      if (lamp.drawn) {
        // Face the viewer but stay upright, like a real flame.
        lamp.drawn.rotation.y = Math.atan2(eyePos.x - lamp.base.x, eyePos.z - lamp.base.z);
        const facingCos = toEye.subVectors(eyePos, lamp.base).normalize().dot(lamp.facing);
        const visible = THREE.MathUtils.smoothstep(facingCos, SIDE_HIDE_TO, SIDE_HIDE_FROM);
        const u = lamp.drawn.material.uniforms;
        u.uTime.value = seconds;
        u.uHeight.value = 1 + DRAWN_STRETCH * flicker - 0.5 * gust;
        u.uLean.value = swayX * DRAWN_LEAN;
        u.uBrightness.value = 1 + 0.2 * flicker - GUST_DIP * gust;
        u.uVisible.value = visible;
        lamp.bloom.material.opacity = BLOOM_STRENGTH * (1 + 0.3 * flicker - GUST_DIP * gust) * visible;
      }
      if (debug) continue; // debug tints stay static so screenshots show them clearly

      if (lamp.baked) {
        warm(lamp.baked, 1 + BAKED_FLICKER * flicker - 2 * GUST_DIP * gust);
        lamp.baked.displace.set(swayX * BAKED_SWAY_M, Math.max(0, flicker) * BAKED_LIFT_M, swayZ * BAKED_SWAY_M);
      }
      warm(lamp.light, 1 + LIGHT_FLICKER * flicker - GUST_DIP * gust);
      lamp.light.position.set(lamp.center.x + swayX * LIGHT_SWAY_M, lamp.center.y, lamp.center.z + swayZ * LIGHT_SWAY_M);
    }
  };
}
