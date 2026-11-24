// Like pick.mjs, but finds bright splats along the ray instead of the gray model surface.
// usage: node tools/pick-splat.mjs <view-slug> <x> <y>
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { findViewNode, makeViewCamera } from '../src/chisel-views.js';
const [slug, px, py] = process.argv.slice(2);
const glb = readFileSync('public/chisel/model.glb');
const gltf = await new GLTFLoader().parseAsync(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.length), '');
gltf.scene.updateMatrixWorld(true);
const { fov } = JSON.parse(readFileSync('public/chisel/views.json', 'utf8')).find((v) => v.slug === slug);
const cam = makeViewCamera(findViewNode(gltf.scene, slug), fov);
const rc = new THREE.Raycaster();
rc.setFromCamera(new THREE.Vector2(((+px + 0.5) / 1280) * 2 - 1, 1 - ((+py + 0.5) / 720) * 2), cam);
const { origin, direction } = rc.ray;
const b = gunzipSync(readFileSync('public/chisel/splat.spz'));
const n = b.readUInt32LE(8), s = 1 / (1 << b[13]), cOff = 16 + n * 10;
const p = new THREE.Vector3(), hits = [];
for (let i = 0; i < n; i++) {
  const v = [0, 1, 2].map((k) => { const o = 16 + (i * 3 + k) * 3; let x = b[o] | (b[o + 1] << 8) | (b[o + 2] << 16); if (x & 0x800000) x |= ~0xffffff; return x * s; });
  p.fromArray(v);
  const t = p.clone().sub(origin).dot(direction);
  if (t < 0.3) continue;
  const off = origin.clone().addScaledVector(direction, t).distanceTo(p);
  if (off > 0.06) continue;
  const bright = (b[cOff + i * 3] + b[cOff + i * 3 + 1] + b[cOff + i * 3 + 2]) / 3;
  hits.push({ t: +t.toFixed(2), bright: Math.round(bright), pos: v.map((x) => +x.toFixed(2)) });
}
hits.sort((a, b) => a.t - b.t);
// The first dense run of splats along the ray is the surface you see; show its brightness.
const bins = new Map();
for (const h of hits) { const k = Math.floor(h.t * 10) / 10; const e = bins.get(k) ?? { n: 0, bright: 0, pos: h.pos }; e.n++; e.bright = Math.max(e.bright, h.bright); bins.set(k, e); }
for (const [t, e] of [...bins].slice(0, 12)) console.log(`t=${t.toFixed(1)}m  splats ${e.n}  max bright ${e.bright}  e.g. ${JSON.stringify(e.pos)}`);
