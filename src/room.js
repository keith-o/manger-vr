import * as THREE from 'three';

// Sample every Nth pixel. 2 gives ~230k vertices, comfortable on a Quest.
const STEP = 2;
// A quad whose corner depths differ by more than this ratio spans an edge between
// a near object and the wall behind it. Dropping it leaves a hole instead of a
// stretched "rubber sheet" — holes read as shadow, stretching reads as broken.
const TEAR_RATIO = 1.05;

// Builds the textured surface from one frame. Returns the mesh and the original
// camera's height above the floor.
export function buildRoom(cam, depthImage, map) {
  const { fx, fy, cx, cy, width: w, height: h } = cam.intrinsics;
  const { data } = depthImage;
  const channels = data.length / (w * h);
  // EXRLoader stores rows bottom-up; flip so v counts down from the image top like the color image.
  const depthAt = (u, v) => data[((h - 1 - v) * w + u) * channels];

  const cols = Math.floor((w - 1) / STEP) + 1;
  const rows = Math.floor((h - 1) / STEP) + 1;
  const positions = new Float32Array(cols * rows * 3);
  const uvs = new Float32Array(cols * rows * 2);
  const depths = new Float32Array(cols * rows);

  // Camera pose ("rub": x right, y up, z back — three.js convention), with its yaw
  // removed so the scene faces -Z, the way you face when the VR session starts.
  const pose = new THREE.Matrix4().compose(
    new THREE.Vector3(...cam.extrinsics.position),
    new THREE.Quaternion(...cam.extrinsics.quaternion),
    new THREE.Vector3(1, 1, 1),
  );
  const yaw = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(...cam.extrinsics.quaternion), 'YXZ').y;
  pose.premultiply(new THREE.Matrix4().makeRotationY(-yaw));

  const p = new THREE.Vector3();
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const u = i * STEP, v = j * STEP, k = j * cols + i;
      // Depth is planar (distance along the view axis), so unproject by scaling the pixel ray's z to d.
      const d = depthAt(u, v);
      p.set(((u + 0.5 - cx) / fx) * d, (-(v + 0.5 - cy) / fy) * d, -d).applyMatrix4(pose);
      p.toArray(positions, k * 3);
      uvs[k * 2] = (u + 0.5) / w;
      uvs[k * 2 + 1] = 1 - (v + 0.5) / h;
      depths[k] = d;
    }
  }

  const indices = [];
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const a = j * cols + i, b = a + 1, c = a + cols, e = c + 1;
      const lo = Math.min(depths[a], depths[b], depths[c], depths[e]);
      const hi = Math.max(depths[a], depths[b], depths[c], depths[e]);
      if (hi / lo > TEAR_RATIO) continue;
      indices.push(a, c, b, b, c, e);
    }
  }

  // Put the floor at y = 0 so it meets the real floor in a local-floor VR session.
  // The lowest couple of percent of points is the straw floor; the very lowest can be noise.
  const ys = [];
  for (let k = 1; k < positions.length; k += 3 * 7) ys.push(positions[k]);
  ys.sort((x, y) => x - y);
  const floorY = ys[Math.floor(ys.length * 0.02)];
  for (let k = 1; k < positions.length; k += 3) positions[k] -= floorY;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);

  // Unlit: the photo already has its lighting baked in.
  const room = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ map, side: THREE.DoubleSide }));
  const cameraHeight = new THREE.Vector3().setFromMatrixPosition(pose).y - floorY;
  return { room, cameraHeight };
}
