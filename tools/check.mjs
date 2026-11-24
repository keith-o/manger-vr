// Headless sanity check of the room geometry: bounds, triangle count, camera height.
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { buildRoom } from '../src/room.js';
const buf = readFileSync('public/scene/depth.exr');
const depth = new EXRLoader().setDataType(THREE.FloatType).parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
const [frame] = JSON.parse(readFileSync('public/scene/cameras.json', 'utf8'));
const { room, cameraHeight } = buildRoom(frame.camera, depth, null);
room.geometry.computeBoundingBox();
const { min, max } = room.geometry.boundingBox;
const tris = room.geometry.index.count / 3, full = (640 * 360) * 2;
console.log({ cameraHeight: +cameraHeight.toFixed(3), triangles: tris, keptPct: +(100 * tris / full).toFixed(1) });
console.log('bounds min', min.toArray().map(n => +n.toFixed(2)), 'max', max.toArray().map(n => +n.toFixed(2)));
