// Finds light sources baked into an .spz splat: clusters of its brightest, opaque splats.
// usage: node tools/find-lights.mjs public/chisel/splat.spz [brightness 0-255]
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
const buf = gunzipSync(readFileSync(process.argv[2]));
const threshold = Number(process.argv[3] ?? 235);
const n = buf.readUInt32LE(8), fractionalBits = buf[13];
const scale = 1 / (1 << fractionalBits);
// spz v2 layout after the 16-byte header: positions (3x24-bit), alphas, colors, scales, rotations.
const posOff = 16, alphaOff = posOff + n * 9, colorOff = alphaOff + n;
const pos = (i, k) => {
  const o = posOff + (i * 3 + k) * 3;
  let v = buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16);
  if (v & 0x800000) v |= ~0xffffff;
  return v * scale;
};
const CELL = 0.25;
const cells = new Map();
for (let i = 0; i < n; i++) {
  if (buf[alphaOff + i] < 150) continue;
  const r = buf[colorOff + i * 3], g = buf[colorOff + i * 3 + 1], b = buf[colorOff + i * 3 + 2];
  if ((r + g + b) / 3 < threshold) continue;
  const p = [pos(i, 0), pos(i, 1), pos(i, 2)];
  const key = p.map((v) => Math.floor(v / CELL)).join(',');
  const c = cells.get(key) ?? { n: 0, sum: [0, 0, 0], col: [0, 0, 0] };
  c.n++; p.forEach((v, k) => (c.sum[k] += v)); [r, g, b].forEach((v, k) => (c.col[k] += v));
  cells.set(key, c);
}
// Merge neighbouring cells into clusters.
const keys = [...cells.keys()], seen = new Set(), clusters = [];
for (const k of keys) {
  if (seen.has(k)) continue;
  const stack = [k], cl = { n: 0, sum: [0, 0, 0], col: [0, 0, 0], min: [9, 9, 9], max: [-9, -9, -9] };
  seen.add(k);
  while (stack.length) {
    const cur = stack.pop(), c = cells.get(cur);
    cl.n += c.n; c.sum.forEach((v, i) => (cl.sum[i] += v)); c.col.forEach((v, i) => (cl.col[i] += v));
    const ijk = cur.split(',').map(Number);
    ijk.forEach((v, i) => { cl.min[i] = Math.min(cl.min[i], v * CELL); cl.max[i] = Math.max(cl.max[i], (v + 1) * CELL); });
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const nk = [ijk[0] + dx, ijk[1] + dy, ijk[2] + dz].join(',');
      if (cells.has(nk) && !seen.has(nk)) { seen.add(nk); stack.push(nk); }
    }
  }
  clusters.push(cl);
}
clusters.sort((a, b) => b.n - a.n);
for (const c of clusters.slice(0, 15)) {
  const f = (a) => a.map((v) => +v.toFixed(2));
  console.log(`splats ${String(c.n).padStart(5)}  center ${JSON.stringify(f(c.sum.map((v) => v / c.n)))}  color ${JSON.stringify(c.col.map((v) => Math.round(v / c.n)))}  box ${JSON.stringify(f(c.min))}..${JSON.stringify(f(c.max))}`);
}
