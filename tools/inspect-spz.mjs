// Summarise an .spz splat: header, point count, and position bounds (to compare with the GLB).
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
const buf = gunzipSync(readFileSync(process.argv[2]));
const magic = buf.readUInt32LE(0), version = buf.readUInt32LE(4), n = buf.readUInt32LE(8);
const shDegree = buf[12], fractionalBits = buf[13], flags = buf[14];
console.log({ magic: magic.toString(16), version, points: n, shDegree, fractionalBits, flags, bytes: buf.length });
const scale = 1 / (1 << fractionalBits);
const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
const per = [[], [], []];
for (let i = 0; i < n; i++) {
  for (let k = 0; k < 3; k++) {
    const o = 16 + (i * 3 + k) * 3;
    let v = buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16);
    if (v & 0x800000) v |= ~0xffffff; // sign-extend 24-bit
    v *= scale;
    min[k] = Math.min(min[k], v); max[k] = Math.max(max[k], v);
    if (i % 50 === 0) per[k].push(v);
  }
}
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return +s[Math.floor(s.length * p)].toFixed(2); };
console.log('bounds min', min.map((v) => +v.toFixed(2)), 'max', max.map((v) => +v.toFixed(2)));
console.log('1%..99% per axis', per.map((a) => [pct(a, 0.01), pct(a, 0.99)]));
