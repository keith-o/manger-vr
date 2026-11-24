// Where in the splat is a pixel of a screenshot taken with ?eye=…&target=… (70° fov, 1280x577: the headless page size)?
// Returns the first solid run of splats along that pixel's ray.
// usage: node tools/pick-splat-cam.mjs ex,ey,ez tx,ty,tz x y [x y ...]
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import * as THREE from 'three';
const [eye, target, ...pix] = process.argv.slice(2);
const cam = new THREE.PerspectiveCamera(70, 1280 / 577, 0.05, 100);
cam.position.fromArray(eye.split(',').map(Number));
cam.lookAt(new THREE.Vector3(...target.split(',').map(Number)));
cam.updateMatrixWorld();
const b = gunzipSync(readFileSync('public/chisel/splat.spz'));
const n = b.readUInt32LE(8), s = 1 / (1 << b[13]), aOff = 16 + n * 9;
const P = new Float32Array(n * 3);
for (let i = 0; i < n * 3; i++) { const o = 16 + i * 3; let x = b[o] | (b[o + 1] << 8) | (b[o + 2] << 16); if (x & 0x800000) x |= ~0xffffff; P[i] = x * s; }
const rc = new THREE.Raycaster();
for (let k = 0; k < pix.length; k += 2) {
  const [px, py] = [+pix[k], +pix[k + 1]];
  rc.setFromCamera(new THREE.Vector2(((px + 0.5) / 1280) * 2 - 1, 1 - ((py + 0.5) / 577) * 2), cam);
  const { origin: o, direction: d } = rc.ray;
  const along = [];
  for (let i = 0; i < n; i++) {
    if (b[aOff + i] < 120) continue;
    const x = P[i * 3] - o.x, y = P[i * 3 + 1] - o.y, z = P[i * 3 + 2] - o.z;
    const t = x * d.x + y * d.y + z * d.z;
    if (t < 0.1) continue;
    const ex = x - t * d.x, ey = y - t * d.y, ez = z - t * d.z;
    if (ex * ex + ey * ey + ez * ez < 0.015 * 0.015) along.push([t, i]);
  }
  along.sort((a, c) => a[0] - c[0]);
  let hit = null;
  for (let j = 0; j + 4 < along.length; j++) if (along[j + 4][0] - along[j][0] < 0.03) { hit = along.slice(j, j + 5); break; }
  if (!hit) { console.log(`(${px},${py}) no surface`); continue; }
  const c = [0, 1, 2].map((a) => hit.reduce((sum, [, i]) => sum + P[i * 3 + a], 0) / hit.length);
  console.log(`(${px},${py}) -> ${c.map((v) => v.toFixed(3)).join(', ')}  at ${hit[0][0].toFixed(2)} m`);
}
