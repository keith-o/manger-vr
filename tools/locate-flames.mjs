// Finds each lamp's baked flame inside the splat itself: near each rough lamp position, the
// whitest opaque splats (a flame core is white; the niche glow around it is yellow, i.e.
// low blue). Prints the core's position and size so lights.json can point at it exactly.
// usage: node tools/locate-flames.mjs [search radius m]
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
const SEARCH = Number(process.argv[2] ?? 0.35);
const TOP = 40;
const b = gunzipSync(readFileSync('public/chisel/splat.spz'));
const n = b.readUInt32LE(8), s = 1 / (1 << b[13]);
const aOff = 16 + n * 9, cOff = aOff + n;
const lamps = JSON.parse(readFileSync('public/chisel/lights.json', 'utf8')).lamps;
const pos = (i) => [0, 1, 2].map((k) => { const o = 16 + (i * 3 + k) * 3; let x = b[o] | (b[o + 1] << 8) | (b[o + 2] << 16); if (x & 0x800000) x |= ~0xffffff; return x * s; });
const near = lamps.map(() => []);
for (let i = 0; i < n; i++) {
  const p = pos(i);
  lamps.forEach((l, j) => {
    const d = Math.hypot(p[0] - l.position[0], p[1] - l.position[1], p[2] - l.position[2]);
    if (d > SEARCH) return;
    const [r, g, bl] = [b[cOff + i * 3], b[cOff + i * 3 + 1], b[cOff + i * 3 + 2]];
    near[j].push({ p, white: Math.min(r, g, bl), alpha: b[aOff + i] });
  });
}
lamps.forEach((l, j) => {
  const top = near[j].filter((x) => x.alpha > 120).sort((a, c) => c.white - a.white).slice(0, TOP);
  const c = [0, 1, 2].map((k) => top.reduce((sum, x) => sum + x.p[k], 0) / top.length);
  const spread = Math.sqrt(top.reduce((sum, x) => sum + (x.p[0] - c[0]) ** 2 + (x.p[1] - c[1]) ** 2 + (x.p[2] - c[2]) ** 2, 0) / top.length);
  const moved = Math.hypot(c[0] - l.position[0], c[1] - l.position[1], c[2] - l.position[2]);
  console.log(`${l.name.padEnd(30)} core ${c.map((v) => v.toFixed(3)).join(', ')}  spread ${(spread * 100).toFixed(1)} cm  whiteness ${top[top.length - 1].white}-${top[0].white}  moved ${(moved * 100).toFixed(0)} cm`);
});
