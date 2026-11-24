import * as THREE from 'three';

// Shared between the VR page and tools/fit: the Chisel export is a gray model plus
// one generated image per named camera node. These helpers find those cameras and
// render depth from them, which is how we both fit their field of view and decide
// which image can see which triangle.

export const VIEW_SLUGS = [
  'hero-1', 'hero-2', 'hero-3', 'hero-4',
  'stabling-level-reference-view', 'rock-cut-cave-wall-and-bench',
  'platform-toward-front-left-floor', 'cave-side-toward-front-right-arch',
  'carved-manger-from-step-side', 'low-beamed-reed-ceiling-rafters',
  'east-wall-and-doorway-latch', 'southwest-ceiling-rafters-and-reeds',
];

// Every Chisel image is 16:9.
export const VIEW_ASPECT = 16 / 9;

export const slugify = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Camera nodes carry no mesh; match them to image files by slugified name.
export function findViewNode(root, slug) {
  let found = null;
  root.traverse((o) => { if (!found && slugify(o.name) === slug) found = o; });
  if (!found) throw new Error(`no camera node for view "${slug}"`);
  return found;
}

// A three.js camera at the node's world pose. glTF cameras look down their local -Z,
// the same convention as three.js, so the pose can be copied over directly.
export function makeViewCamera(node, fovDeg, near = 0.05, far = 50) {
  const cam = new THREE.PerspectiveCamera(fovDeg, VIEW_ASPECT, near, far);
  node.updateWorldMatrix(true, false);
  const scale = new THREE.Vector3();
  node.matrixWorld.decompose(cam.position, cam.quaternion, scale);
  cam.updateMatrixWorld(true);
  return cam;
}

// Writes view-space z-depth (meters along the view axis) into the red channel.
const depthMaterial = new THREE.ShaderMaterial({
  side: THREE.DoubleSide,
  vertexShader: /* glsl */ `
    varying float vDepth;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vDepth = -mv.z;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */ `
    varying float vDepth;
    void main() { gl_FragColor = vec4(vDepth, 0.0, 0.0, 1.0); }`,
});

// Renders z-depth of `scene` from `camera` and reads it back to the CPU.
// Background pixels come back as 0 (nothing there). Rows are bottom-up, as in GL.
export function renderDepth(renderer, scene, camera, width, height) {
  const target = new THREE.WebGLRenderTarget(width, height, { type: THREE.FloatType });
  const prev = { override: scene.overrideMaterial, bg: scene.background, target: renderer.getRenderTarget() };
  scene.overrideMaterial = depthMaterial;
  scene.background = null;
  renderer.setRenderTarget(target);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();
  renderer.render(scene, camera);
  const rgba = new Float32Array(width * height * 4);
  renderer.readRenderTargetPixels(target, 0, 0, width, height, rgba);
  renderer.setRenderTarget(prev.target);
  scene.overrideMaterial = prev.override;
  scene.background = prev.bg;
  target.dispose();
  const depth = new Float32Array(width * height);
  for (let i = 0; i < depth.length; i++) depth[i] = rgba[i * 4];
  return depth;
}
