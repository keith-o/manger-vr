import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import { findViewNode, makeViewCamera } from './chisel-views.js';
import { buildProjectedRoom, setBrightness } from './projection.js';
import { addLamps } from './lamps.js';

// The Chisel room in VR, shown two ways you can switch between (A/X in VR, T on desktop):
//   splat  — Marble's Gaussian splat of the room (default)
//   paint  — the gray model painted with the 12 generated views; built on first use
// URL options for checking on desktop:
//   ?look=paint    start with the painted model
//   ?view=<slug>   look through one view's camera (the paint should match its image)
//   ?debug=views   color each painted surface by which view painted it
//   ?budget=<n>    splat budget as a fraction of Spark's default (see SPLAT_BUDGET)
//   ?minpx=<n>     smallest splat size in pixels worth drawing (see SPLAT_MIN_PIXELS)
// Shimmer diagnosis (add ?fps=1 to see a frame-rate readout under your view in the headset):
//   ?res=<n>       headset render resolution scale, e.g. 0.6
//   ?fov=1         turn Spark's foveation back on (less detail away from where you look)
//   ?lod=0         no level-of-detail: draw all 2M splats every frame
//   ?eye=x,y,z&target=x,y,z   put the desktop camera anywhere (e.g. close to a lamp)
//   ?flametest=1   lift the baked (bench) flame region 12 cm and tint it blue, to check placement
//   ?markers=1     show light positions (green lamps, red darkened spots), flicker paused

// Where you start: the room's "reference view", standing on the floor.
const SPAWN_VIEW = 'stabling-level-reference-view';
const MOVE_SPEED = 1.4; // m/s, left thumbstick
const SNAP_TURN_DEG = 30; // right thumbstick left/right
const STICK_DEADZONE = 0.2;
const BRIGHTNESS_MIN = 0.5, BRIGHTNESS_MAX = 2.5, BRIGHTNESS_RATE = 1; // per second, right stick up/down
// Fraction of Spark's default splat count (500-750K in VR). Fewer splats means quicker
// re-sorting as you move, which is what shows up as the scene visibly redrawing.
const SPLAT_BUDGET = 1;
// Splats smaller than this many pixels are dropped in favor of coarser ones. Spark's default
// is 1; it says up to 5 is often indistinguishable.
const SPLAT_MIN_PIXELS = 1;

const params = new URLSearchParams(location.search);
const status = document.getElementById('status');

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
// Headset render resolution (1 = the headset's recommendation). Splats cost per pixel
// covered, so this is the biggest frame-rate lever: on Quest 3, 1.0 ran at ~25 fps and
// 0.6 at ~35. Must be set before the session starts.
const XR_RESOLUTION = 0.7;
renderer.xr.setFramebufferScaleFactor(Number(params.get('res') ?? XR_RESOLUTION));
// The headset's own fixed foveation: renders the lens edges at lower resolution.
renderer.xr.setFoveation(1);
document.body.appendChild(renderer.domElement);
document.body.appendChild(VRButton.createButton(renderer));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);

// In VR the headset pose is relative to the camera's parent, so moving `rig` moves the player.
const rig = new THREE.Group();
scene.add(rig);
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 100);
rig.add(camera);

// Frame-rate readout fixed below your line of sight (?fps=1), so the headset can report it.
const fpsCanvas = Object.assign(document.createElement('canvas'), { width: 256, height: 64 });
const fpsTexture = new THREE.CanvasTexture(fpsCanvas);
fpsTexture.colorSpace = THREE.SRGBColorSpace;
const fpsPanel = new THREE.Mesh(
  new THREE.PlaneGeometry(0.16, 0.04),
  new THREE.MeshBasicMaterial({ map: fpsTexture, transparent: true, depthTest: false }),
);
fpsPanel.position.set(0, -0.22, -0.6);
fpsPanel.renderOrder = 999;
if (params.get('fps') === '1') camera.add(fpsPanel);
let fpsFrames = 0, fpsSince = performance.now();
function updateFps(now) {
  fpsFrames++;
  if (now - fpsSince < 1000) return;
  const fps = Math.round((fpsFrames * 1000) / (now - fpsSince));
  fpsFrames = 0;
  fpsSince = now;
  const ctx = fpsCanvas.getContext('2d');
  ctx.clearRect(0, 0, 256, 64);
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(0, 0, 256, 64);
  ctx.fillStyle = '#fff';
  ctx.font = '36px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`${fps} fps`, 128, 46);
  fpsTexture.needsUpdate = true;
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

const [gltf, viewList] = await Promise.all([
  new GLTFLoader().loadAsync('./chisel/model.glb'),
  fetch('./chisel/views.json').then((r) => r.json()),
]);
const views = viewList.map(({ slug, fov }) => ({ slug, fov, camera: makeViewCamera(findViewNode(gltf.scene, slug), fov) }));

// The splat shares the gray model's frame (same origin, meters, y up), so it needs no transform.
// `lod` builds a level-of-detail tree on load; Spark then draws a budget of splats picked
// for the current view (about 500-750K in VR, more on desktop) out of the 2M in the file.
const splatBudget = Number(params.get('budget') ?? SPLAT_BUDGET);
const splatMinPixels = Number(params.get('minpx') ?? SPLAT_MIN_PIXELS);
// Spark's gaze foveation (less detail away from where you look) is off by default: on Quest 3
// it made peripheral splats re-sharpen visibly when you turned, and the scene ran faster
// without it (~45 fps vs ~25). ?fov=1 turns it back on.
const foveation = params.get('fov') === '1' ? {} : { coneFoveate: 1, behindFoveate: 1 };
const spark = new SparkRenderer({ renderer, lodSplatScale: splatBudget, lodRenderScale: splatMinPixels, ...foveation });
console.log('[splat]', JSON.stringify({ budget: splatBudget, minPx: splatMinPixels, res: params.get('res') ?? XR_RESOLUTION, foveation: params.get('fov') === '1', lod: params.get('lod') !== '0' }));
scene.add(spark);
const t0 = performance.now();
const splat = new SplatMesh({ url: './chisel/splat.spz', lod: params.get('lod') !== '0' });
scene.add(splat);
await splat.initialized;
const updateLamps = await addLamps(splat, scene, {
  eye: (target) => (renderer.xr.isPresenting ? renderer.xr.getCamera() : camera).getWorldPosition(target),
  markers: params.get('markers') === '1',
  flameTest: params.get('flametest') === '1',
});
console.log('[splat] loaded in', Math.round(performance.now() - t0), 'ms');

let painted = null;
async function paintedRoom() {
  if (painted) return painted;
  status.textContent = 'painting room…';
  const textureLoader = new THREE.TextureLoader();
  await Promise.all(views.map(async (v) => {
    v.texture = await textureLoader.loadAsync(`./chisel/views/${v.slug}.jpg`);
    v.texture.colorSpace = THREE.SRGBColorSpace;
    v.texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  }));
  const t = performance.now();
  const { mesh, stats } = buildProjectedRoom(renderer, gltf.scene, views, { debugColors: params.get('debug') === 'views' });
  console.log('[room] built in', Math.round(performance.now() - t), 'ms', JSON.stringify(stats));
  setBrightness(mesh, brightness);
  scene.add(mesh);
  painted = mesh;
  return painted;
}

let look = 'splat';
let switching = false;
async function showLook(next) {
  if (switching) return;
  switching = true;
  if (next === 'paint') await paintedRoom();
  look = next;
  splat.visible = look === 'splat';
  if (painted) painted.visible = look === 'paint';
  status.textContent = `${look} · T to switch · drag to look around · Enter VR on the headset`;
  console.log('[look]', look);
  switching = false;
}
addEventListener('keydown', (e) => { if (e.key === 't' || e.key === 'T') showLook(look === 'splat' ? 'paint' : 'splat'); });

// Spawn: standing where the reference view was taken, facing the way it faced.
const spawn = views.find((v) => v.slug === SPAWN_VIEW).camera;
const spawnYaw = new THREE.Euler().setFromQuaternion(spawn.quaternion, 'YXZ').y;
function resetRig() {
  rig.position.set(spawn.position.x, 0, spawn.position.z);
  rig.rotation.set(0, spawnYaw, 0);
}

// Desktop preview.
const controls = new OrbitControls(camera, renderer.domElement);
const lookThrough = views.find((v) => v.slug === params.get('view'));
if (lookThrough) {
  camera.position.copy(lookThrough.camera.position);
  camera.quaternion.copy(lookThrough.camera.quaternion);
  camera.fov = lookThrough.fov;
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  controls.enabled = false;
} else if (params.has('eye')) {
  camera.position.fromArray(params.get('eye').split(',').map(Number));
  controls.target.fromArray((params.get('target') ?? '0,1,0').split(',').map(Number));
  controls.update();
} else {
  camera.position.copy(spawn.position);
  controls.target.copy(spawn.position).add(new THREE.Vector3(0, 0, -2).applyQuaternion(spawn.quaternion));
  controls.update();
}

renderer.xr.addEventListener('sessionstart', () => {
  // Hand the camera to the headset: it now sits at the rig origin, moved by the player.
  camera.position.set(0, 0, 0);
  camera.quaternion.identity();
  resetRig();
});
renderer.xr.addEventListener('sessionend', () => {
  rig.position.set(0, 0, 0);
  rig.rotation.set(0, 0, 0);
  camera.position.copy(spawn.position);
  controls.update();
});

let brightness = 1;
function applyBrightness() {
  splat.recolor.setScalar(brightness);
  if (painted) setBrightness(painted, brightness);
}
let turnArmed = true;
const prevToggle = new WeakMap();
const clock = new THREE.Clock();
const head = new THREE.Vector3(), forward = new THREE.Vector3(), right = new THREE.Vector3();

function handleSticks(session, dt) {
  for (const source of session.inputSources) {
    const pad = source.gamepad;
    if (!pad) continue;
    // xr-standard mapping: thumbstick is axes[2] (x) and axes[3] (y, up is negative).
    const sx = pad.axes[2] ?? 0, sy = pad.axes[3] ?? 0;
    // buttons[4] is A (right) / X (left): switch between splat and painted model.
    const toggle = pad.buttons[4]?.pressed ?? false;
    if (toggle && !prevToggle.get(source)) showLook(look === 'splat' ? 'paint' : 'splat');
    prevToggle.set(source, toggle);
    if (source.handedness === 'left') {
      if (Math.hypot(sx, sy) < STICK_DEADZONE) continue;
      // Move where the head looks, kept level so looking down doesn't sink you into the floor.
      const xrCam = renderer.xr.getCamera();
      xrCam.getWorldDirection(forward).setY(0).normalize();
      right.crossVectors(forward, THREE.Object3D.DEFAULT_UP);
      rig.position.addScaledVector(forward, -sy * MOVE_SPEED * dt).addScaledVector(right, sx * MOVE_SPEED * dt);
    } else if (source.handedness === 'right') {
      if (Math.abs(sx) > 0.7 && turnArmed) {
        // Turn around the head, not the rig origin, so the view doesn't swing sideways.
        turnArmed = false;
        renderer.xr.getCamera().getWorldPosition(head);
        const angle = THREE.MathUtils.degToRad(-Math.sign(sx) * SNAP_TURN_DEG);
        rig.position.sub(head).applyAxisAngle(THREE.Object3D.DEFAULT_UP, angle).add(head);
        rig.rotation.y += angle;
      } else if (Math.abs(sx) < 0.3) {
        turnArmed = true;
      }
      if (Math.abs(sy) > STICK_DEADZONE) {
        brightness = THREE.MathUtils.clamp(brightness - sy * BRIGHTNESS_RATE * dt, BRIGHTNESS_MIN, BRIGHTNESS_MAX);
        applyBrightness();
      }
    }
  }
}

await showLook(params.get('look') === 'paint' ? 'paint' : 'splat');
// Headless screenshots wait for this; splat sorting is asynchronous, so give it a moment.
setTimeout(() => console.log('[done]'), 4000);

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  updateFps(performance.now());
  updateLamps(clock.elapsedTime);
  const session = renderer.xr.getSession();
  if (session) handleSticks(session, dt);
  else if (controls.enabled) controls.update();
  renderer.render(scene, camera);
});
