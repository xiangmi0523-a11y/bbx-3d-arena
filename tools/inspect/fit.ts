import * as THREE from 'three';
import { buildPartModel } from '../../src/game/beys/BeyVisualFactory';
import type { AssembledBey } from '../../src/game/beys/parts/assemble';

/**
 * P2.3 阶段 2：零件装配关系的几何检查（用真实网格，不靠截图判断）。
 *
 *  - measureSeat：在 Disc 范围内按极坐标网格竖直打射线，求 Blade 底面最低点与 Disc 顶面最高点的间隙。
 *    间隙 < 0 = 穿插；间隙 ≈ 0 = 贴合支承；间隙 > 0 = 留空。
 *  - findCoplanar：找出不同网格之间共面且重叠的三角形（实时渲染里会闪烁的 z-fighting 来源）。
 */

export interface SeatReport {
  samples: number;
  /** 两者都有表面的采样点数 */
  overlapping: number;
  minGap: number;
  /** 间隙 < -0.0005 的采样点（穿插） */
  penetrating: number;
  /** |间隙| ≤ 0.002 的采样点占 Disc 顶面采样的比例（支承面） */
  contactRatio: number;
  /** 穿插最深处的位置 */
  worst: { r: number; a: number; gap: number } | null;
}

/** 把零件模型放到装配位置，并换成双面材质（只用于射线求交，不影响共用材质） */
function placed(spec: AssembledBey, kind: 'blade' | 'disc' | 'tip'): THREE.Group {
  const g = buildPartModel(spec[kind]);
  g.position.y = spec.layers[kind].bottom;
  const hitMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) m.material = hitMat;
  });
  g.updateMatrixWorld(true);
  return g;
}

export function measureSeat(spec: AssembledBey, dr = 0.004, da = 2): SeatReport {
  const blade = placed(spec, 'blade');
  const disc = placed(spec, 'disc');
  const ray = new THREE.Raycaster();
  const top = spec.totalHeight + 1;
  const R = spec.disc.radius * 1.03;
  let samples = 0;
  let overlapping = 0;
  let discHits = 0;
  let contact = 0;
  let penetrating = 0;
  let minGap = Infinity;
  let worst: SeatReport['worst'] = null;
  for (let r = dr / 2; r <= R; r += dr) {
    for (let deg = 0; deg < 360; deg += da) {
      samples++;
      const a = (deg * Math.PI) / 180;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      // Disc 顶面：从上往下第一个交点
      ray.set(new THREE.Vector3(x, top, z), new THREE.Vector3(0, -1, 0));
      const dHit = ray.intersectObject(disc, true)[0];
      // Blade 底面：从下往上第一个交点
      ray.set(new THREE.Vector3(x, -1, z), new THREE.Vector3(0, 1, 0));
      const bHit = ray.intersectObject(blade, true)[0];
      if (dHit) discHits++;
      if (!dHit || !bHit) continue;
      overlapping++;
      const gap = bHit.point.y - dHit.point.y;
      if (gap < minGap) minGap = gap;
      if (gap < -0.0005) {
        penetrating++;
        if (!worst || gap < worst.gap) worst = { r, a: deg, gap };
      }
      if (Math.abs(gap) <= 0.002) contact++;
    }
  }
  return {
    samples,
    overlapping,
    minGap: Number.isFinite(minGap) ? minGap : NaN,
    penetrating,
    contactRatio: discHits ? contact / discHits : 0,
    worst,
  };
}

export interface CoplanarReport {
  /** 来自不同网格、共面且投影重叠的三角形对数 */
  pairs: number;
  examples: string[];
}

/**
 * 共面重叠检测：按（法线, 平面距离）分桶，同一桶里来自不同网格的三角形若包围盒在平面内重叠，计一对。
 * 法线反向的两个面：只要其中一个是透明件就算（透过透明件能看到背后贴着的面，会闪）；两个都不透明则互相遮住，不算。
 */
export function findCoplanar(root: THREE.Object3D, tolN = 0.002, tolD = 0.0002): CoplanarReport {
  root.updateMatrixWorld(true);
  type Tri = { mesh: string; box: THREE.Box3; flipped: boolean; transparent: boolean; p2: [number, number][] };
  const buckets = new Map<string, Tri[]>();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  let meshIndex = 0;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const id = `${meshIndex++}:${m.parent?.name ?? ''}`;
    const transparent = (Array.isArray(m.material) ? m.material : [m.material]).some((mt) => mt.transparent);
    const pos = m.geometry.attributes.position;
    const idx = m.geometry.index;
    const count = (idx ? idx.count : pos.count) / 3;
    for (let t = 0; t < count; t++) {
      const i0 = idx ? idx.getX(t * 3) : t * 3;
      const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
      a.fromBufferAttribute(pos, i0).applyMatrix4(m.matrixWorld);
      b.fromBufferAttribute(pos, i1).applyMatrix4(m.matrixWorld);
      c.fromBufferAttribute(pos, i2).applyMatrix4(m.matrixWorld);
      n.subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
      const len = n.length();
      if (len < 1e-10) continue;
      n.multiplyScalar(1 / len);
      // 统一法线朝向（反向的面放进同一桶）
      const flipped = n.y < -1e-9 || (Math.abs(n.y) <= 1e-9 && (n.x < -1e-9 || (Math.abs(n.x) <= 1e-9 && n.z < 0)));
      if (flipped) n.negate();
      const d = n.dot(a);
      const key = `${Math.round(n.x / tolN)},${Math.round(n.y / tolN)},${Math.round(n.z / tolN)},${Math.round(d / tolD)}`;
      const box = new THREE.Box3().setFromPoints([a, b, c]);
      // 平面内的二维坐标（基向量由取整后的法线决定，同一桶内一致）
      const nq = new THREE.Vector3(Math.round(n.x / tolN), Math.round(n.y / tolN), Math.round(n.z / tolN)).normalize();
      const u = Math.abs(nq.y) < 0.9 ? new THREE.Vector3(0, 1, 0).cross(nq).normalize() : new THREE.Vector3(1, 0, 0).cross(nq).normalize();
      const w = nq.clone().cross(u);
      const p2: [number, number][] = [a, b, c].map((p) => [p.dot(u), p.dot(w)]);
      const list = buckets.get(key) ?? [];
      list.push({ mesh: id, box, flipped, transparent, p2 });
      buckets.set(key, list);
    }
  });
  let pairs = 0;
  const examples: string[] = [];
  for (const [key, list] of buckets) {
    if (list.length < 2) continue;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (list[i].mesh === list[j].mesh) continue;
        // 两个不透明面背对背贴合（例如上下两层零件的接触面）：互相遮住，看不到，不会闪烁
        if (list[i].flipped !== list[j].flipped && !list[i].transparent && !list[j].transparent) continue;
        // 平面内的三角形真正重叠（分离轴检验；只共享一条边、一个点的不算）
        if (!overlap2D(list[i].p2, list[j].p2)) continue;
        pairs++;
        const ex = `${list[i].mesh} × ${list[j].mesh} @ ${key}`;
        if (examples.length < 12 && !examples.includes(ex)) examples.push(ex);
      }
    }
  }
  return { pairs, examples };
}

/** 两个二维三角形的内部是否重叠（分离轴定理，接触边视为不重叠） */
function overlap2D(A: [number, number][], B: [number, number][], eps = 1e-6): boolean {
  for (const T of [A, B]) {
    for (let i = 0; i < 3; i++) {
      const [x0, y0] = T[i];
      const [x1, y1] = T[(i + 1) % 3];
      const ax = -(y1 - y0);
      const ay = x1 - x0;
      const len = Math.hypot(ax, ay);
      if (len < 1e-12) continue;
      let minA = Infinity;
      let maxA = -Infinity;
      let minB = Infinity;
      let maxB = -Infinity;
      for (const [x, y] of A) {
        const d = (x * ax + y * ay) / len;
        minA = Math.min(minA, d);
        maxA = Math.max(maxA, d);
      }
      for (const [x, y] of B) {
        const d = (x * ax + y * ay) / len;
        minB = Math.min(minB, d);
        maxB = Math.max(maxB, d);
      }
      if (maxA <= minB + eps || maxB <= minA + eps) return false;
    }
  }
  return true;
}
