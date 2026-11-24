import * as THREE from 'three';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { buildRoom } from './room.js';

// One Viewfinder frame (color + metric depth + camera) turned into a textured surface.
// It's 2.5D: only what the camera saw exists, so it looks best near the original viewpoint.

// Brightness range for the thumbstick; the source image is very dark.
const BRIGHTNESS_MIN = 0.5;
const BRIGHTNESS_MAX = 3;

const status = document.getElementById('status');

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
document.body.appendChild(renderer.domElement);
document.body.appendChild(VRButton.createButton(renderer));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);

const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.05, 100);
const controls = new OrbitControls(camera, renderer.domElement);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

const [frame] = await (await fetch('./scene/cameras.json')).json();
const [color, depth] = await Promise.all([
  new THREE.TextureLoader().loadAsync('./scene/color.jpg'),
  new EXRLoader().setDataType(THREE.FloatType).loadAsync('./scene/depth.exr'),
]);
color.colorSpace = THREE.SRGBColorSpace;
color.anisotropy = renderer.capabilities.getMaxAnisotropy();

const { room, cameraHeight } = buildRoom(frame.camera, depth.image, color);
scene.add(room);

// Desktop preview: start at the original camera and orbit a point a few meters ahead.
camera.position.set(0, cameraHeight, 0);
controls.target.set(0, cameraHeight, -3);
controls.update();
status.textContent = 'drag to look around · Enter VR on the headset';

// In VR the headset sits ~1.6 m up, but the photo was taken from ~0.8 m.
// B/Y lines the original eye height up with yours, which hides most of the holes.
let matchEyeHeight = false;
let brightness = 1;
const prevButtons = new WeakMap();

renderer.setAnimationLoop(() => {
  const session = renderer.xr.getSession();
  if (session) {
    for (const source of session.inputSources) {
      const pad = source.gamepad;
      if (!pad) continue;
      // xr-standard mapping: axes[3] is thumbstick Y, buttons[5] is B / Y.
      const stickY = pad.axes[3] ?? 0;
      if (Math.abs(stickY) > 0.2) {
        brightness = THREE.MathUtils.clamp(brightness - stickY * 0.03, BRIGHTNESS_MIN, BRIGHTNESS_MAX);
        room.material.color.setScalar(brightness);
      }
      const pressed = pad.buttons[5]?.pressed ?? false;
      if (pressed && !prevButtons.get(source)) {
        matchEyeHeight = !matchEyeHeight;
        const headY = renderer.xr.getCamera().position.y;
        room.position.y = matchEyeHeight ? headY - cameraHeight : 0;
      }
      prevButtons.set(source, pressed);
    }
  } else {
    controls.update();
  }
  renderer.render(scene, camera);
});
