// Where in the room is a pixel of a view? Casts a ray from a view camera through a pixel
// and reports where it hits the gray model.
// usage: node tools/pick.mjs <view-slug> <x> <y> [imageW imageH]
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { findViewNode, makeViewCamera } from '../src/chisel-views.js';
const [slug, px, py, w = 1280, h = 720] = process.argv.slice(2);
const buf = readFileSync('public/chisel/model.glb');
const gltf = await new GLTFLoader().parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length), '');
gltf.scene.updateMatrixWorld(true);
const { fov } = JSON.parse(readFileSync('public/chisel/views.json', 'utf8')).find((v) => v.slug === slug);
const cam = makeViewCamera(findViewNode(gltf.scene, slug), fov);
const ndc = new THREE.Vector2(((+px + 0.5) / w) * 2 - 1, 1 - ((+py + 0.5) / h) * 2);
const ray = new THREE.Raycaster();
ray.setFromCamera(ndc, cam);
const hit = ray.intersectObject(gltf.scene, true)[0];
console.log(hit ? { point: hit.point.toArray().map((v) => +v.toFixed(2)), object: hit.object.name || hit.object.parent?.name, distance: +hit.distance.toFixed(2) } : 'no hit');
