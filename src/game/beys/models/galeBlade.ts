import * as THREE from 'three';
import { createGaleEmblemTexture } from '../../render/textures';
import type { BladeSpec } from '../parts/types';

/**
 * 「疾风新月」Blade（基础平衡型，银 + 蓝）。P2.3 阶段 1 按设计参考图重新建模。
 *
 * 参考图的结构拆解（俯视从外到内）：
 *  1. 银色爪刃：10 枚沿圆周斜向前掠的多面切削爪刃，大小交替（5 大 5 小），爪与爪之间留缝露出蓝色，
 *     每枚两端都是尖的——后端在内侧形成指向中心的棱锥尖，前端在外缘形成向前突出的刃尖；
 *     刃身中间有一条偏外侧的高脊，脊两侧是大切面，平面着色下明暗分明。
 *  2. 银色外环带：爪刃下方的一圈低矮金属带，被 V 形缺口分段。
 *  3. 蓝色透明底盘：最下层，从爪刃之间和外缘透出；底面有同心台阶（底视图的同心圆）。
 *  4. 蓝色透明骨架：爪刃内侧的一圈，带 8 根辐条和镂空窗口。
 *  5. 中心：深色塑料徽标座 + 原创徽标 + 银色压圈 + 低矮透明护罩（徽标图案为原创，不使用参考图里的龙头）。
 *
 * 只生成外观。碰撞体仍是 BeyPhysics 里按部件参数建的圆柱，这里的外形全部控制在
 * 碰撞半径 × 1.03、碰撞厚度 × 1.25 以内（tests/visual-bounds.test.ts 检查）。
 * 底面在本地 y = 0，形状 5 重旋转对称（形心在转轴上，旋转时不显得偏心）。
 */

// ───────────────────────── 材质（银色金属 / 蓝色透明塑料 / 深色塑料 三类明确区分） ─────────────────────────

function silverMetal(): THREE.MeshStandardMaterial {
  // 平面着色：每个切面独立反射环境光，形成刀刃的明暗棱面
  return new THREE.MeshStandardMaterial({ color: 0xd2d8e1, metalness: 1, roughness: 0.2, envMapIntensity: 1.3, flatShading: true });
}

function blueClear(opacity: number): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    // ACES 色调映射会把高亮的纯蓝推向紫色、正面高光会把它冲成浅蓝：
    // 底色带一点绿并压低亮度，高光靠少量清漆，主要颜色来自自发光，渲染出来才是参考图那种深宝蓝
    color: 0x041d6e,
    emissive: 0x0a3ccc,
    emissiveIntensity: 0.55,
    metalness: 0,
    roughness: 0.3,
    clearcoat: 0,
    envMapIntensity: 0.12,
    specularIntensity: 0.35,
    transparent: true,
    opacity,
    depthWrite: false,
    side: THREE.DoubleSide,
    forceSinglePass: true,
  });
}

function darkPlastic(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: 0x0c111d, metalness: 0.1, roughness: 0.42 });
}

function clearDome(): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.14,
    roughness: 0.03,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.02,
    depthWrite: false,
    side: THREE.DoubleSide,
    forceSinglePass: true,
  });
}

// ───────────────────────── 爪刃几何 ─────────────────────────

interface ClawSpec {
  /** 后端（内侧尖）所在角度 */
  a0: number;
  /** 刃身沿圆周扫过的角度（正 = 旋转前进方向） */
  span: number;
  /** 后端尖、刃根、刃尖的半径（相对 R） */
  rTail: number;
  rRoot: number;
  rTip: number;
  /** 刃身最大宽度（相对 R） */
  width: number;
  /** 底面、脊线最高点、刃尖的高度（相对 H） */
  yBase: number;
  yRidge: number;
  yTip: number;
}

/**
 * 一枚爪刃 = 沿弧形中线排布的若干截面，每个截面是“外缘 - 高脊 - 内缘”三点顶面 + 两点底面。
 * 两端截面宽度为 0，形成尖端。截面很少（6 个），每个切面都足够大，远看也能读出棱角。
 */
function clawGeometry(R: number, H: number, c: ClawSpec, dir: number, out: number[]): void {
  // 截面：t 为沿刃身的位置（-0.12 = 后端内尖，1 = 前端刃尖）
  const ts = [-0.12, 0, 0.3, 0.6, 0.86, 1];
  const widthAt = (t: number) => (t <= 0 ? (t < -0.1 ? 0 : 0.95) : t >= 1 ? 0 : t < 0.6 ? 0.85 + 0.15 * (t / 0.6) : 1 - 0.55 * ((t - 0.6) / 0.4));
  const radiusAt = (t: number) => {
    if (t < 0) return c.rTail;
    const e = t * t * (3 - 2 * t);
    return c.rRoot + (c.rTip - c.rRoot) * e;
  };
  const ridgeAt = (t: number) => {
    if (t < 0) return c.yBase + (c.yRidge - c.yBase) * 0.6;
    if (t >= 1) return c.yTip;
    // 脊线在刃身中段最高，前端略降形成刃尖
    const up = Math.min(1, t / 0.55);
    const down = t > 0.7 ? (t - 0.7) / 0.3 : 0;
    return c.yBase + (c.yRidge - c.yBase) * (0.75 + 0.25 * up) - (c.yRidge - c.yTip) * down;
  };
  type Sec = { L: THREE.Vector3; M: THREE.Vector3; Rr: THREE.Vector3; bL: THREE.Vector3; bR: THREE.Vector3; side: THREE.Vector3 };
  const secs: Sec[] = ts.map((t) => {
    const a = c.a0 + dir * c.span * t;
    const r = R * radiusAt(t);
    const w = R * c.width * widthAt(t);
    // 中线方向（切向 + 向外的径向分量），求出截面的横向（垂直中线、水平）
    const dt = 0.02;
    const a2 = c.a0 + dir * c.span * (t + dt);
    const r2 = R * radiusAt(Math.min(1, t + dt));
    const p = new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r);
    const p2 = new THREE.Vector3(Math.cos(a2) * r2, 0, Math.sin(a2) * r2);
    const fwd = p2.sub(p).normalize();
    let side = new THREE.Vector3(-fwd.z, 0, fwd.x);
    // side 统一指向外侧（远离转轴）
    if (side.dot(p) < 0) side = side.multiplyScalar(-1);
    const yR = H * ridgeAt(t);
    const yEdge = H * (c.yBase + (ridgeAt(t) - c.yBase) * 0.3);
    const yIn = H * (c.yBase + (ridgeAt(t) - c.yBase) * 0.45);
    const yB = H * c.yBase;
    // 高脊偏向外侧：外侧切面陡、内侧切面宽
    const outerW = w * 0.42;
    const innerW = w * 0.58;
    const ridgeShift = w * 0.12;
    return {
      Rr: p.clone().addScaledVector(side, outerW).setY(yEdge),
      M: p.clone().addScaledVector(side, ridgeShift).setY(yR),
      L: p.clone().addScaledVector(side, -innerW).setY(yIn),
      bR: p.clone().addScaledVector(side, outerW).setY(yB),
      bL: p.clone().addScaledVector(side, -innerW).setY(yB),
      side,
    };
  });
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const n = new THREE.Vector3();
  // 每个面给出期望的朝向（顶面朝上、外壁朝外、内壁朝内、底面朝下），按它校正绕序
  const tri = (p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, want: THREE.Vector3) => {
    ab.subVectors(p1, p0);
    ac.subVectors(p2, p0);
    n.crossVectors(ab, ac);
    if (n.lengthSq() < 1e-14) return;
    if (n.dot(want) < 0) out.push(p0.x, p0.y, p0.z, p2.x, p2.y, p2.z, p1.x, p1.y, p1.z);
    else out.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
  };
  const quad = (a: THREE.Vector3, b: THREE.Vector3, c2: THREE.Vector3, d: THREE.Vector3, want: THREE.Vector3) => {
    tri(a, b, c2, want);
    tri(a, c2, d, want);
  };
  const UP = new THREE.Vector3(0, 1, 0);
  const DOWN = new THREE.Vector3(0, -1, 0);
  for (let i = 0; i < secs.length - 1; i++) {
    const s = secs[i];
    const e = secs[i + 1];
    const out = s.side.clone().add(e.side).normalize();
    const inward = out.clone().negate();
    // 内侧切面朝上并略朝内，外侧切面朝上并略朝外
    quad(s.L, e.L, e.M, s.M, UP.clone().addScaledVector(inward, 0.3));
    quad(s.M, e.M, e.Rr, s.Rr, UP.clone().addScaledVector(out, 0.3));
    quad(s.Rr, e.Rr, e.bR, s.bR, out); // 外侧壁
    quad(s.bL, e.bL, e.L, s.L, inward); // 内侧壁
    quad(s.bL, s.bR, e.bR, e.bL, DOWN); // 底面
  }
}

function clawRingGeometry(R: number, H: number, claws: ClawSpec[], dir: number): THREE.BufferGeometry {
  const pos: number[] = [];
  for (const c of claws) clawGeometry(R, H, c, dir, pos);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}

// ───────────────────────── 其他构件 ─────────────────────────

/** 旋转体：profile 为闭合截面 [r, y]，segments 少一些得到多边形棱面 */
function lathe(profile: [number, number][], segments: number): THREE.BufferGeometry {
  const pts = profile.map(([r, y]) => new THREE.Vector2(r, y));
  pts.push(pts[0].clone());
  const geo = new THREE.LatheGeometry(pts, segments);
  return geo;
}

/** 水平厚片（Shape 挤出），底面在 y=0 */
function slab(shape: THREE.Shape, depth: number, bevel: number): THREE.BufferGeometry {
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.001, depth - bevel * 2),
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 1,
    curveSegments: 24,
  });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, bevel, 0);
  geo.computeVertexNormals();
  return geo;
}

/** 极坐标点 → Shape 平面坐标（放平后 shape 的 y 对应 -z） */
const P = (r: number, a: number) => new THREE.Vector2(Math.cos(a) * r, -Math.sin(a) * r);

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, y = 0, order = 0): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.y = y;
  // 固定透明件的绘制顺序（底盘 → 骨架 → 护罩），旋转时不会因为排序翻转而闪烁
  m.renderOrder = order;
  return m;
}

// ───────────────────────── 组装 ─────────────────────────

export function buildGaleBlade(spec: BladeSpec): THREE.Group {
  const g = new THREE.Group();
  g.name = `blade:${spec.id}`;
  const R = spec.radius;
  const H = spec.height;
  // 右旋 = 俯视顺时针，刃尖朝旋转前进方向；左旋时镜像
  const dir = spec.spin === 'left' ? -1 : 1;
  const TAU = Math.PI * 2;

  const mSilver = silverMetal();
  const mBlue = blueClear(0.82);
  const mDark = darkPlastic();

  // 1) 蓝色透明底盘：底面三级同心台阶，外缘略向上收
  g.add(
    mesh(
      lathe(
        [
          [R * 0.24, H * 0.12],
          [R * 0.42, H * 0.12],
          [R * 0.42, H * 0.06],
          [R * 0.62, H * 0.06],
          [R * 0.62, 0],
          [R * 0.86, 0],
          [R * 0.93, H * 0.08],
          [R * 0.93, H * 0.24],
          [R * 0.24, H * 0.3],
        ],
        48,
      ),
      mBlue,
      0,
      1,
    ),
  );

  // 2) 银色外环带：16 边形低矮金属带，上沿倒角
  g.add(
    mesh(
      lathe(
        [
          [R * 0.84, H * 0.14],
          [R * 0.95, H * 0.14],
          [R * 0.965, H * 0.2],
          [R * 0.95, H * 0.28],
          [R * 0.85, H * 0.3],
        ],
        16,
      ),
      mSilver,
    ),
  );

  // 3) 银色爪刃：5 大 5 小交替，窄而尖、沿旋转方向前掠，爪与爪之间留缝露出蓝色骨架
  const claws: ClawSpec[] = [];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * TAU;
    claws.push({ a0: a, span: 0.6, rTail: 0.56, rRoot: 0.66, rTip: 0.965, width: 0.25, yBase: 0.24, yRidge: 1.18, yTip: 0.7 });
    claws.push({ a0: a + (dir * TAU) / 10, span: 0.44, rTail: 0.64, rRoot: 0.72, rTip: 0.93, width: 0.17, yBase: 0.22, yRidge: 0.95, yTip: 0.55 });
  }
  g.add(mesh(clawRingGeometry(R, H, claws, dir), mSilver));

  // 4) 蓝色透明骨架：内环 + 8 根辐条 + 8 个镂空窗
  const frame = new THREE.Shape();
  frame.absarc(0, 0, R * 0.7, 0, TAU, false);
  const hole = new THREE.Path();
  hole.absarc(0, 0, R * 0.36, 0, TAU, true);
  frame.holes.push(hole);
  for (let i = 0; i < 8; i++) {
    const a0 = (i / 8) * TAU + 0.12;
    const a1 = ((i + 1) / 8) * TAU - 0.12;
    const win = new THREE.Path();
    const steps = 6;
    const pts: THREE.Vector2[] = [];
    for (let k = 0; k <= steps; k++) pts.push(P(R * 0.62, a0 + ((a1 - a0) * k) / steps));
    for (let k = steps; k >= 0; k--) pts.push(P(R * 0.44, a0 + 0.03 + ((a1 - a0 - 0.06) * k) / steps));
    win.setFromPoints(pts);
    frame.holes.push(win);
  }
  g.add(mesh(slab(frame, H * 0.4, R * 0.015), mBlue, H * 0.3, 2));

  // 5) 中心：深色徽标座 → 原创徽标 → 银色压圈 → 透明护罩
  g.add(mesh(lathe([[R * 0.3, H * 0.4], [R * 0.4, H * 0.4], [R * 0.4, H * 0.74], [R * 0.37, H * 0.8], [R * 0.3, H * 0.8]], 32), mDark));
  const emblemMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0.05 });
  // 单元测试在 Node 里构建模型，没有 Canvas 时只用纯色
  if (typeof document !== 'undefined') emblemMat.map = createGaleEmblemTexture();
  else emblemMat.color.set(0x16233f);
  const emblem = new THREE.Mesh(new THREE.CircleGeometry(R * 0.355, 48), emblemMat);
  emblem.rotation.x = -Math.PI / 2;
  // 徽标随旋转方向镜像，前掠方向与刀刃一致
  if (dir < 0) emblem.scale.x = -1;
  emblem.position.y = H * 0.805;
  g.add(emblem);
  const bezel = new THREE.Mesh(new THREE.TorusGeometry(R * 0.37, R * 0.022, 6, 48), mSilver);
  bezel.rotation.x = Math.PI / 2;
  bezel.position.y = H * 0.81;
  g.add(bezel);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(R * 0.36, 32, 8, 0, TAU, 0, Math.PI / 2), clearDome());
  dome.scale.y = 0.3;
  dome.position.y = H * 0.8;
  dome.renderOrder = 3;
  g.add(dome);
  return g;
}
