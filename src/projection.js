import * as THREE from 'three';
import { renderDepth } from './chisel-views.js';

// Paints the gray model with the generated images, like slide projectors. Each triangle
// takes its color from the one image that sees it best: fully unblocked, most head-on,
// and closest. Choosing per triangle (not blending per pixel) keeps it to one texture
// lookup per pixel, which the Quest can afford at full frame rate.

// Long walls and floors are split until no edge is longer than this, so a surface that's
// half hidden behind the manger in one view can take that half from another view.
const MAX_EDGE = 0.2;
// Resolution of the depth maps used to test whether a view can see a point.
const DEPTH_W = 1280, DEPTH_H = 720;
// A point counts as seen if it is no further than the nearest surface plus this slack.
// The ratio part covers floors seen at a low angle, where depth changes fast across a pixel.
const DEPTH_SLACK_M = 0.03, DEPTH_SLACK_RATIO = 0.02;
// Points tested per piece (centroid + three corners), and how many a view must see to be
// used as a last resort when no view sees them all.
const SAMPLES = 4;
const MIN_PARTIAL_SAMPLES = 1;
// Views seeing a surface more edge-on than this are skipped: the image would smear.
const MIN_FACING = 0.2;
// Samples this close to the image border are treated as outside it.
const EDGE_MARGIN = 0.98;
// Color for surfaces no image saw: reads as shadow rather than as a hole.
const UNSEEN_COLOR = 0x0d0a07;

const projectorVertex = /* glsl */ `
  uniform mat4 projView;
  varying vec4 vProj;
  void main() {
    // Projectors live in model space, so project the untransformed position: moving the
    // player rig or the world must not slide the images across the walls.
    vProj = projView * vec4(position, 1.0);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;
const projectorFragment = /* glsl */ `
  uniform sampler2D map;
  uniform float brightness;
  varying vec4 vProj;
  void main() {
    vec2 uv = vProj.xy / vProj.w * 0.5 + 0.5;
    gl_FragColor = vec4(texture2D(map, uv).rgb * brightness, 1.0);
    #include <colorspace_fragment>
  }`;

export function buildProjectedRoom(renderer, model, views, { debugColors = false } = {}) {
  model.updateMatrixWorld(true);
  const original = collectTriangles(model);
  const { pieces: tris, parent } = subdivide(original, MAX_EDGE);
  const triCount = tris.length / 9;
  const parentCount = original.length / 9;
  const V = views.length;

  // Depth from every view, rendered from the gray model itself, so visibility matches
  // exactly the geometry being painted.
  const depthScene = new THREE.Scene().add(model);
  const probes = views.map((v) => ({
    cam: v.camera,
    pos: v.camera.position,
    projView: new THREE.Matrix4().multiplyMatrices(v.camera.projectionMatrix, v.camera.matrixWorldInverse),
    depth: renderDepth(renderer, depthScene, v.camera, DEPTH_W, DEPTH_H),
  }));
  depthScene.remove(model);

  // Pass 1: for every piece and view, how many of its sample points the view sees, and
  // how good a look it gets (texel density falls off with distance and edge-on angle).
  const seen = new Uint8Array(triCount * V);
  const score = new Float32Array(triCount * V);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const n = new THREE.Vector3(), centroid = new THREE.Vector3(), toCam = new THREE.Vector3();
  const samples = Array.from({ length: SAMPLES }, () => new THREE.Vector3());
  const clip = new THREE.Vector4();

  for (let t = 0; t < triCount; t++) {
    a.fromArray(tris, t * 9); b.fromArray(tris, t * 9 + 3); c.fromArray(tris, t * 9 + 6);
    centroid.copy(a).add(b).add(c).divideScalar(3);
    n.subVectors(c, b).cross(a.clone().sub(b));
    if (n.lengthSq() === 0) continue;
    n.normalize();
    // Corners pulled slightly inward, so a sample never sits exactly on an occluding edge.
    samples[0].copy(centroid);
    samples[1].copy(a).lerp(centroid, 0.15);
    samples[2].copy(b).lerp(centroid, 0.15);
    samples[3].copy(c).lerp(centroid, 0.15);

    for (let v = 0; v < V; v++) {
      const p = probes[v];
      toCam.subVectors(p.pos, centroid);
      const dist = toCam.length();
      // Abs: the model's surfaces aren't consistently wound, and the depth test already
      // rules out seeing a surface from behind a wall.
      const facing = Math.abs(n.dot(toCam) / dist);
      if (facing < MIN_FACING) continue;
      let count = 0;
      for (const s of samples) if (seenBy(p, s, clip)) count++;
      seen[t * V + v] = count;
      score[t * V + v] = facing / dist;
    }
  }

  // Each original face votes for one view: the one that fully sees the most of its pieces.
  // Pieces use that view whenever it fully sees them, so a wall stays one image as far as
  // possible instead of a patchwork of differently lit images.
  const votes = new Float32Array(parentCount * V);
  for (let t = 0; t < triCount; t++) {
    for (let v = 0; v < V; v++) if (seen[t * V + v] === SAMPLES) votes[parent[t] * V + v] += 1 + score[t * V + v] * 0.01;
  }
  const preferred = new Int8Array(parentCount).fill(-1);
  for (let f = 0; f < parentCount; f++) {
    let best = 0;
    for (let v = 0; v < V; v++) if (votes[f * V + v] > best) { best = votes[f * V + v]; preferred[f] = v; }
  }

  // Pass 2: the face's view if it fully sees this piece; else the best view that does;
  // else the view that sees the most of it (an edge piece, partly hidden from every view:
  // a little of the occluder's color beats a black hole).
  const choice = new Int8Array(triCount).fill(-1);
  for (let t = 0; t < triCount; t++) {
    const pref = preferred[parent[t]];
    if (pref >= 0 && seen[t * V + pref] === SAMPLES) { choice[t] = pref; continue; }
    let best = -1, bestKey = 0;
    for (let v = 0; v < V; v++) {
      const k = seen[t * V + v];
      if (k < MIN_PARTIAL_SAMPLES) continue;
      const key = k * 1000 + score[t * V + v]; // most samples first, then best look
      if (key > bestKey) { bestKey = key; best = v; }
    }
    choice[t] = best;
  }

  // Faces no view saw at all go back to being one triangle: the walls' outer sides and the
  // floor's underside would otherwise cost hundreds of thousands of triangles for nothing.
  const anySeen = new Uint8Array(parentCount);
  for (let t = 0; t < triCount; t++) if (choice[t] >= 0) anySeen[parent[t]] = 1;
  const keptTris = [], keptChoice = [];
  for (let t = 0; t < triCount; t++) {
    if (!anySeen[parent[t]]) continue;
    keptTris.push(tris.subarray(t * 9, t * 9 + 9));
    keptChoice.push(choice[t]);
  }
  for (let f = 0; f < parentCount; f++) {
    if (anySeen[f]) continue;
    keptTris.push(original.subarray(f * 9, f * 9 + 9));
    keptChoice.push(-1);
  }
  const merged = new Float32Array(keptTris.length * 9);
  keptTris.forEach((t, i) => merged.set(t, i * 9));

  return buildMesh(merged, Int8Array.from(keptChoice), views, debugColors);
}

function seenBy(probe, point, clip) {
  clip.set(point.x, point.y, point.z, 1).applyMatrix4(probe.projView);
  if (clip.w <= probe.cam.near) return false;
  const x = clip.x / clip.w, y = clip.y / clip.w;
  if (Math.abs(x) > EDGE_MARGIN || Math.abs(y) > EDGE_MARGIN) return false;
  const px = Math.min(DEPTH_W - 1, Math.floor((x * 0.5 + 0.5) * DEPTH_W));
  const py = Math.min(DEPTH_H - 1, Math.floor((y * 0.5 + 0.5) * DEPTH_H));
  const surface = probe.depth[py * DEPTH_W + px];
  if (surface === 0) return true; // nothing nearer was drawn there
  // For a perspective camera, clip.w is the point's distance along the view axis.
  return clip.w <= surface + DEPTH_SLACK_M + surface * DEPTH_SLACK_RATIO;
}

// Every triangle of every mesh, in model (world) space, as a flat xyz array.
function collectTriangles(root) {
  const out = [];
  const v = new THREE.Vector3();
  root.traverse((o) => {
    if (!o.isMesh) return;
    const pos = o.geometry.attributes.position;
    const index = o.geometry.index;
    const count = index ? index.count : pos.count;
    for (let i = 0; i < count; i++) {
      v.fromBufferAttribute(pos, index ? index.getX(i) : i).applyMatrix4(o.matrixWorld);
      out.push(v.x, v.y, v.z);
    }
  });
  return new Float32Array(out);
}

// Splits each triangle across its longest edge until every edge is at most maxEdge.
// Returns the pieces plus, for each piece, the index of the original triangle it came from.
function subdivide(input, maxEdge) {
  const out = [];
  const parent = [];
  const stack = [];
  const maxSq = maxEdge * maxEdge;
  for (let i = 0; i < input.length; i += 9) {
    stack.push(Array.from(input.subarray(i, i + 9)));
    while (stack.length) {
      const t = stack.pop();
      const e = [d2(t, 0, 3), d2(t, 3, 6), d2(t, 6, 0)];
      const longest = e.indexOf(Math.max(...e));
      if (e[longest] <= maxSq) { out.push(...t); parent.push(i / 9); continue; }
      const i0 = longest * 3, i1 = ((longest + 1) % 3) * 3, i2 = ((longest + 2) % 3) * 3;
      const m = [(t[i0] + t[i1]) / 2, (t[i0 + 1] + t[i1 + 1]) / 2, (t[i0 + 2] + t[i1 + 2]) / 2];
      const p = (k) => [t[k], t[k + 1], t[k + 2]];
      stack.push([...p(i0), ...m, ...p(i2)], [...m, ...p(i1), ...p(i2)]);
    }
  }
  return { pieces: new Float32Array(out), parent: Int32Array.from(parent) };
}

const d2 = (t, i, j) => (t[i] - t[j]) ** 2 + (t[i + 1] - t[j + 1]) ** 2 + (t[i + 2] - t[j + 2]) ** 2;

// One draw group per view (plus one for unseen surfaces), so each pixel samples one texture.
function buildMesh(tris, choice, views, debugColors) {
  const triCount = choice.length;
  const order = [...Array(triCount).keys()].sort((x, y) => choice[x] - choice[y]);
  const positions = new Float32Array(triCount * 9);
  order.forEach((t, i) => positions.set(tris.subarray(t * 9, t * 9 + 9), i * 9));

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  const materials = [new THREE.MeshBasicMaterial({ color: UNSEEN_COLOR })];
  const counts = new Array(views.length + 1).fill(0);
  for (const t of order) counts[choice[t] + 1]++;
  let start = 0;
  counts.forEach((count, g) => {
    if (count) geometry.addGroup(start * 3, count * 3, g);
    start += count;
  });

  views.forEach((v, i) => {
    const debugColor = new THREE.Color().setHSL(i / views.length, 0.7, 0.5);
    materials.push(debugColors
      ? new THREE.MeshBasicMaterial({ color: debugColor })
      : new THREE.ShaderMaterial({
          uniforms: {
            map: { value: v.texture },
            projView: { value: new THREE.Matrix4().multiplyMatrices(v.camera.projectionMatrix, v.camera.matrixWorldInverse) },
            brightness: { value: 1 },
          },
          vertexShader: projectorVertex,
          fragmentShader: projectorFragment,
          side: THREE.DoubleSide,
        }));
  });
  materials[0].side = THREE.DoubleSide;

  const mesh = new THREE.Mesh(geometry, materials);
  const stats = {
    triangles: triCount,
    unseenPct: +((100 * counts[0]) / triCount).toFixed(1),
    perView: Object.fromEntries(views.map((v, i) => [v.slug, counts[i + 1]])),
  };
  return { mesh, stats };
}

// Brightness applies to every projected material at once (thumbstick control in VR).
export function setBrightness(mesh, value) {
  for (const m of mesh.material) if (m.uniforms?.brightness) m.uniforms.brightness.value = value;
}
