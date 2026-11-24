// Summarise a GLB without a browser: meshes, triangle counts, materials, textures, bounds.
import { readFileSync } from 'node:fs';
const buf = readFileSync(process.argv[2]);
const jsonLen = buf.readUInt32LE(12);
const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
console.log('generator:', gltf.asset?.generator, '| extensions:', gltf.extensionsUsed ?? []);
console.log('nodes', gltf.nodes?.length, 'meshes', gltf.meshes?.length, 'materials', gltf.materials?.length, 'textures', gltf.textures?.length, 'images', gltf.images?.length);
let tris = 0;
const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
for (const m of gltf.meshes ?? []) {
  let mt = 0;
  for (const p of m.primitives) {
    const pos = gltf.accessors[p.attributes.POSITION];
    const n = p.indices != null ? gltf.accessors[p.indices].count : pos.count;
    mt += n / 3;
    pos.min?.forEach((v, i) => (min[i] = Math.min(min[i], v)));
    pos.max?.forEach((v, i) => (max[i] = Math.max(max[i], v)));
  }
  tris += mt;
  console.log(` mesh "${m.name}": ${m.primitives.length} prim, ${mt} tris, attrs ${Object.keys(m.primitives[0].attributes).join(',')}`);
}
console.log('total tris', tris, '| raw bounds (before node transforms)', min.map(v => +v.toFixed(2)), max.map(v => +v.toFixed(2)));
for (const n of gltf.nodes ?? []) if (n.matrix || n.scale || n.rotation || n.translation) console.log(' node', n.name, JSON.stringify({ t: n.translation, r: n.rotation, s: n.scale, m: n.matrix }));
for (const mat of gltf.materials ?? []) console.log(' material', mat.name, JSON.stringify(mat.pbrMetallicRoughness ?? {}), mat.extensions ? Object.keys(mat.extensions) : '');
for (const img of gltf.images ?? []) console.log(' image', img.name, img.mimeType, img.bufferView != null ? gltf.bufferViews[img.bufferView].byteLength + ' bytes' : img.uri);
