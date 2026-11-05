import * as THREE from 'three';

/** 一个模型（或模型的一部分）在本地坐标中的视觉包围数据 */
export interface VisualBounds {
  /** 到转轴（本地 Y 轴）的最大水平距离 */
  radial: number;
  yMin: number;
  yMax: number;
  /**
   * 表面面积加权的形心到转轴的水平距离。
   * 不用包围盒中心：三叶等奇数对称的零件，包围盒中心天然不在轴上。
   */
  centroidOffset: number;
  meshes: number;
  triangles: number;
  /** 不同的材质实例数 */
  materials: number;
  transparentMeshes: number;
}

const _v = new THREE.Vector3();

/**
 * 逐顶点测量模型（含子节点变换）在 root 本地坐标中的范围。
 * 用顶点而不是 Box3：Box3 在 xz 上是方的，测不准旋转对称零件的真实外径。
 */
export function measureVisual(root: THREE.Object3D): VisualBounds {
  root.updateMatrixWorld(true);
  const inv = root.matrixWorld.clone().invert();
  let radial = 0;
  let yMin = Infinity;
  let yMax = -Infinity;
  let areaSum = 0;
  let cx = 0;
  let cz = 0;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  let meshes = 0;
  let triangles = 0;
  let transparentMeshes = 0;
  const mats = new Set<string>();
  const m = new THREE.Matrix4();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    meshes++;
    const geo = mesh.geometry;
    const pos = geo.attributes.position;
    triangles += (geo.index ? geo.index.count : pos.count) / 3;
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mt of list) mats.add(mt.uuid);
    if (list.some((mt) => mt.transparent)) transparentMeshes++;
    m.multiplyMatrices(inv, mesh.matrixWorld);
    for (let i = 0; i < pos.count; i++) {
      _v.fromBufferAttribute(pos, i).applyMatrix4(m);
      radial = Math.max(radial, Math.hypot(_v.x, _v.z));
      yMin = Math.min(yMin, _v.y);
      yMax = Math.max(yMax, _v.y);
    }
    const idx = geo.index;
    const triCount = (idx ? idx.count : pos.count) / 3;
    for (let t = 0; t < triCount; t++) {
      const i0 = idx ? idx.getX(t * 3) : t * 3;
      const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
      a.fromBufferAttribute(pos, i0).applyMatrix4(m);
      b.fromBufferAttribute(pos, i1).applyMatrix4(m);
      c.fromBufferAttribute(pos, i2).applyMatrix4(m);
      const area = _v.subVectors(b, a).cross(c.clone().sub(a)).length() / 2;
      areaSum += area;
      cx += area * (a.x + b.x + c.x) / 3;
      cz += area * (a.z + b.z + c.z) / 3;
    }
  });
  return {
    radial,
    yMin,
    yMax,
    centroidOffset: areaSum > 0 ? Math.hypot(cx / areaSum, cz / areaSum) : 0,
    meshes,
    triangles: Math.round(triangles),
    materials: mats.size,
    transparentMeshes,
  };
}
