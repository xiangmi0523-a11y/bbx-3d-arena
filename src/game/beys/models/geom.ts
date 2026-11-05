import * as THREE from 'three';
import { mergeGeometries, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** 陀螺零件共用的几何工具（P2.3，从疾风新月 Blade 中提出，行为不变） */

/** 折角大于这个角度的棱保持锐利，小于的平滑过渡 */
export const CREASE = THREE.MathUtils.degToRad(20);

// ───────────────────────── 几何工具 ─────────────────────────

/** 把一组顶点（每 3 个一个三角形）和 UV 转成带锐利棱线的网格 */
export function creased(pos: number[], uv: number[]): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return toCreasedNormals(geo, CREASE);
}

/**
 * 旋转体：profile 为闭合截面 [r, y]。截面的拐角保持锐利（每条边单独成带），
 * 绕轴方向平滑——不再是多边形棱面。
 */
export function lathe(profile: [number, number][], segments: number): THREE.BufferGeometry {
  const pts = profile.map(([r, y]) => new THREE.Vector2(r, y));
  pts.push(pts[0].clone());
  const geo = new THREE.LatheGeometry(pts, segments);
  geo.deleteAttribute('normal');
  return toCreasedNormals(geo, CREASE);
}

/** 截面拐角做倒角：每个指定拐角换成两个点，各沿相邻边退 c */
export function chamfer(profile: [number, number][], c: number, corners?: number[]): [number, number][] {
  const out: [number, number][] = [];
  const n = profile.length;
  for (let i = 0; i < n; i++) {
    const p = profile[i];
    if (corners && !corners.includes(i)) {
      out.push(p);
      continue;
    }
    const a = profile[(i - 1 + n) % n];
    const b = profile[(i + 1) % n];
    const da = Math.hypot(a[0] - p[0], a[1] - p[1]);
    const db = Math.hypot(b[0] - p[0], b[1] - p[1]);
    const ka = da > 1e-9 ? Math.min(c, da * 0.4) / da : 0;
    const kb = db > 1e-9 ? Math.min(c, db * 0.4) / db : 0;
    out.push([p[0] + (a[0] - p[0]) * ka, p[1] + (a[1] - p[1]) * ka]);
    out.push([p[0] + (b[0] - p[0]) * kb, p[1] + (b[1] - p[1]) * kb]);
  }
  return out;
}

/** 水平厚片（Shape 挤出，圆角倒边），底面在 y=0 */
export function slab(shape: THREE.Shape, depth: number, bevel: number, bevelSegments = 2, curveSegments = 32): THREE.BufferGeometry {
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.001, depth - bevel * 2),
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments,
    curveSegments,
  });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, bevel, 0);
  geo.deleteAttribute('normal');
  return toCreasedNormals(geo, CREASE);
}

/** 极坐标点 → Shape 平面坐标（放平后 shape 的 y 对应 -z） */
export const P = (r: number, a: number) => new THREE.Vector2(Math.cos(a) * r, -Math.sin(a) * r);

export function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, y = 0, order = 0): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.y = y;
  // 固定透明件的绘制顺序（底盘 → 骨架 → 护罩），旋转时不会因为排序翻转而闪烁
  m.renderOrder = order;
  return m;
}

/** 合并前统一属性（mergeGeometries 要求相同的属性集合和索引方式） */
function norm(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (!g.getAttribute('uv')) {
    const n = g.getAttribute('position').count;
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
  }
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
  return g;
}

export function merge(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(list.map(norm));
  if (!g) throw new Error('mergeGeometries failed');
  return g;
}

