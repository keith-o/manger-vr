import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VIEW_SLUGS, findViewNode, makeViewCamera, renderDepth } from '../src/chisel-views.js';

// Chisel doesn't store each camera's field of view, but it does give the depth image it
// rendered from the gray model. Render our own depth at candidate FOVs and keep the one
// whose depth ranks pixels most like theirs. Rank correlation doesn't care how they mapped
// meters to gray levels, only that nearer is consistently lighter (or darker).
// Open /tools/fit.html; the result is logged as JSON for public/chisel/views.json.

const W = 160, H = 90;
const out = document.getElementById('out');

const renderer = new THREE.WebGLRenderer();
const gltf = await new GLTFLoader().loadAsync('/chisel/model.glb');
const scene = new THREE.Scene();
scene.add(gltf.scene);
scene.updateMatrixWorld(true);

const box = new THREE.Box3().setFromObject(gltf.scene);
console.log('[fit] model bounds', box.min.toArray().map((v) => v.toFixed(2)), box.max.toArray().map((v) => v.toFixed(2)));

async function loadGray(url) {
  const img = await new THREE.ImageLoader().loadAsync(url);
  const canvas = Object.assign(document.createElement('canvas'), { width: W, height: H });
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, W, H);
  const px = ctx.getImageData(0, 0, W, H).data;
  // Canvas rows are top-down; flip to bottom-up so they line up with GL readback.
  const gray = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) gray[(H - 1 - y) * W + x] = px[(y * W + x) * 4];
  return gray;
}

function ranks(values) {
  const order = [...values.keys()].sort((a, b) => values[a] - values[b]);
  const r = new Float32Array(values.length);
  order.forEach((idx, rank) => (r[idx] = rank));
  return r;
}

function pearson(a, b) {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; sab += da * db; saa += da * da; sbb += db * db; }
  return sab / Math.sqrt(saa * sbb);
}

function score(theirs, node, fov) {
  const ours = renderDepth(renderer, scene, makeViewCamera(node, fov), W, H);
  const a = [], b = [];
  for (let i = 0; i < ours.length; i++) if (ours[i] > 0) { a.push(ours[i]); b.push(theirs[i]); }
  if (a.length < ours.length * 0.5) return 0; // camera mostly looking at nothing: wrong pose or FOV
  // Near is lighter in their image, so correlate against negative depth.
  return pearson(ranks(a.map((v) => -v)), ranks(b));
}

const results = [];
for (const slug of VIEW_SLUGS) {
  const node = findViewNode(gltf.scene, slug);
  const theirs = await loadGray(`/chisel/depth/${slug}.png`);
  let best = { fov: 0, r: -1 };
  for (let fov = 20; fov <= 110; fov += 2) { const r = score(theirs, node, fov); if (r > best.r) best = { fov, r }; }
  for (let fov = best.fov - 2; fov <= best.fov + 2; fov += 0.25) { const r = score(theirs, node, fov); if (r > best.r) best = { fov, r }; }
  results.push({ slug, node: node.name, fov: best.fov, fit: +best.r.toFixed(4) });
  console.log(`[fit] ${slug}: fov ${best.fov}° r=${best.r.toFixed(4)}`);
}
const json = JSON.stringify(results, null, 2);
out.textContent = json;
console.log('[fit] RESULT ' + JSON.stringify(results));
console.log('[done]');
