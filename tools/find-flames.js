import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { findViewNode, makeViewCamera } from '../src/chisel-views.js';

// Finds the flames in the generated views: small blobs of near-white pixels, each traced
// back into the room by casting a ray from that view's camera onto the gray model.
// Flames seen from several views land close together, which confirms them; the flame's
// actual position is then triangulated from those views' rays (the gray model has flat
// walls where the generated images have recessed niches, so the ray hits are only a guide).
// Open /tools/find-flames.html; results are logged as JSON.

const CORE = (r, g, b) => r >= 250 && g >= 240 && b >= 190; // white-hot flame core
const MIN_PX = 4, MAX_PX = 1500; // ignore single noisy pixels and large blown-out areas
const CLUSTER_M = 0.3;

const gltf = await new GLTFLoader().loadAsync('/chisel/model.glb');
gltf.scene.updateMatrixWorld(true);
const views = await (await fetch('/chisel/views.json')).json();
const raycaster = new THREE.Raycaster();
const hits = [];

for (const { slug, fov } of views) {
  const img = await new THREE.ImageLoader().loadAsync(`/chisel/views/${slug}.jpg`);
  const w = img.width, h = img.height;
  const ctx = Object.assign(document.createElement('canvas'), { width: w, height: h }).getContext('2d');
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, w, h).data;
  const hot = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) hot[i] = CORE(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]) ? 1 : 0;

  // Connected blobs of hot pixels.
  const seen = new Uint8Array(w * h);
  const cam = makeViewCamera(findViewNode(gltf.scene, slug), fov);
  for (let start = 0; start < w * h; start++) {
    if (!hot[start] || seen[start]) continue;
    const stack = [start];
    seen[start] = 1;
    let n = 0, sx = 0, sy = 0, maxY = 0;
    while (stack.length) {
      const i = stack.pop(), x = i % w, y = (i - x) / w;
      n++; sx += x; sy += y; maxY = Math.max(maxY, y);
      for (const j of [i - 1, i + 1, i - w, i + w]) {
        if (j >= 0 && j < w * h && hot[j] && !seen[j] && Math.abs((j % w) - x) <= 1) { seen[j] = 1; stack.push(j); }
      }
    }
    if (n < MIN_PX || n > MAX_PX) continue;
    // Aim at the blob's centre; a flame's base is lower, but the centre is what glows.
    const ndc = new THREE.Vector2(((sx / n + 0.5) / w) * 2 - 1, 1 - ((sy / n + 0.5) / h) * 2);
    raycaster.setFromCamera(ndc, cam);
    const hit = raycaster.intersectObject(gltf.scene, true)[0];
    if (hit) hits.push({ slug, px: n, point: hit.point.toArray(), origin: raycaster.ray.origin.clone(), dir: raycaster.ray.direction.clone() });
  }
}

// Group hits from different views that land near each other.
const clusters = [];
for (const hit of hits) {
  const p = new THREE.Vector3(...hit.point);
  let c = clusters.find((c) => c.center.distanceTo(p) < CLUSTER_M);
  if (!c) clusters.push((c = { center: p.clone(), hits: [] }));
  c.hits.push(hit);
  c.center.set(0, 0, 0);
  for (const h of c.hits) c.center.add(new THREE.Vector3(...h.point));
  c.center.divideScalar(c.hits.length);
}
// Least-squares point closest to a set of rays: sum (I - d d^T) p = sum (I - d d^T) o.
function triangulate(rays) {
  const A = new THREE.Matrix3().set(0, 0, 0, 0, 0, 0, 0, 0, 0), b = new THREE.Vector3();
  for (const { origin: o, dir: d } of rays) {
    const m = new THREE.Matrix3().set(
      1 - d.x * d.x, -d.x * d.y, -d.x * d.z,
      -d.y * d.x, 1 - d.y * d.y, -d.y * d.z,
      -d.z * d.x, -d.z * d.y, 1 - d.z * d.z);
    for (let i = 0; i < 9; i++) A.elements[i] += m.elements[i];
    b.add(o.clone().applyMatrix3(m));
  }
  const p = b.applyMatrix3(A.invert());
  const residual = Math.max(...rays.map(({ origin: o, dir: d }) => {
    const t = p.clone().sub(o).dot(d);
    return o.clone().addScaledVector(d, t).distanceTo(p);
  }));
  return { p, residual };
}

// The splat is trained to reproduce every view, so a ray through a flame pixel must pass
// through the splat's own flame: the first solid run of splats along it. One point per
// view, then the median, gives the flame's position in the splat itself.
const spz = new Uint8Array(await new Response((await fetch('/chisel/splat.spz')).body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
const dv = new DataView(spz.buffer);
const N = dv.getUint32(8, true), SCALE = 1 / (1 << spz[13]), A_OFF = 16 + N * 9;
const SP = new Float32Array(N * 3);
for (let i = 0; i < N * 3; i++) { const o = 16 + i * 3; let x = spz[o] | (spz[o + 1] << 8) | (spz[o + 2] << 16); if (x & 0x800000) x |= ~0xffffff; SP[i] = x * SCALE; }
function firstSurface({ origin: o, dir: d }) {
  const along = [];
  for (let i = 0; i < N; i++) {
    if (spz[A_OFF + i] < 120) continue;
    const px = SP[i * 3] - o.x, py = SP[i * 3 + 1] - o.y, pz = SP[i * 3 + 2] - o.z;
    const t = px * d.x + py * d.y + pz * d.z;
    if (t < 0.2) continue;
    const ex = px - t * d.x, ey = py - t * d.y, ez = pz - t * d.z;
    if (ex * ex + ey * ey + ez * ez > 0.015 * 0.015) continue;
    along.push(i);
  }
  const t = (i) => (SP[i * 3] - o.x) * d.x + (SP[i * 3 + 1] - o.y) * d.y + (SP[i * 3 + 2] - o.z) * d.z;
  along.sort((a, b) => t(a) - t(b));
  // First place where 5 splats fall within 3 cm of each other along the ray.
  for (let k = 0; k + 4 < along.length; k++) {
    if (t(along[k + 4]) - t(along[k]) > 0.03) continue;
    const run = along.slice(k, k + 5);
    return new THREE.Vector3(...[0, 1, 2].map((a) => run.reduce((sum, i) => sum + SP[i * 3 + a], 0) / run.length));
  }
  return null;
}
const median = (vals) => { const v = [...vals].sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };

clusters.sort((a, b) => b.hits.length - a.hits.length);
for (const c of clusters) {
  const views = [...new Set(c.hits.map((h) => h.slug))];
  if (views.length < 3) continue; // seen in too few views to trust
  // One ray per view: its biggest blob (the flame core, not stray halo pieces).
  const rays = views.map((v) => c.hits.filter((h) => h.slug === v).sort((a, b) => b.px - a.px)[0]);
  const { p, residual } = triangulate(rays);
  const surface = rays.map(firstSurface).filter(Boolean);
  if (surface.length) {
    const m = new THREE.Vector3(median(surface.map((p) => p.x)), median(surface.map((p) => p.y)), median(surface.map((p) => p.z)));
    const spread = Math.max(...surface.map((p) => p.distanceTo(m)));
    console.log(`[flames] in splat: ${m.toArray().map((v) => v.toFixed(3)).join(', ')} (views agree within ${(spread * 100).toFixed(0)} cm, ${surface.length} views)`);
  }
  console.log(`[flames] hit ${c.center.toArray().map((v) => v.toFixed(2)).join(', ')} -> triangulated ${p.toArray().map((v) => v.toFixed(2)).join(', ')} (rays within ${(residual * 100).toFixed(0)} cm)  views ${views.length}: ${views.join(' ')}`);
}
console.log('[done]');
