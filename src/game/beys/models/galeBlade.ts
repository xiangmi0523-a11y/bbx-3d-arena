import * as THREE from 'three';
import { P, chamfer, creased, lathe, merge, mesh, slab } from './geom';
import { bluePlastic, clearDome, darkPlastic, galeEmblem, polishedMetal, satinMetal } from './materials';
import type { BladeSpec } from '../parts/types';

/**
 * 「疾风新月」Blade（基础平衡型，银 + 蓝）。P2.3 阶段 1 按设计参考图重新建模，
 * P2.3 阶段 1.1 提升到“产品渲染”质感（造型、比例、配色不变）。
 *
 * 参考图的结构拆解（俯视从外到内）：
 *  1. 银色爪刃：10 枚沿圆周斜向前掠的多面切削爪刃，大小交替（5 大 5 小），爪与爪之间留缝露出蓝色，
 *     每枚两端都是尖的——后端在内侧形成指向中心的棱锥尖，前端在外缘形成向前突出的刃尖；
 *     刃身中间有一条偏外侧的高脊，脊两侧是大切面。
 *  2. 银色外环带：爪刃下方的一圈低矮金属带。
 *  3. 蓝色透明底盘：最下层，从爪刃之间和外缘透出；底面有同心台阶，内部有加强筋。
 *  4. 蓝色透明骨架：爪刃内侧的一圈，带 8 根辐条和镂空窗口，辐条上有固定螺丝。
 *  5. 中心：深色塑料徽标座 + 原创徽标 + 滚花银色压圈 + 低矮透明护罩（徽标为原创，不使用参考图里的龙头）。
 *
 * 产品质感的做法（全部是实时渲染，游戏里与检视页一致）：
 *  - 几何：爪刃截面在棱边处做小倒角，沿刃身密集采样成连续曲面；按折角分法线（toCreasedNormals），
 *    切面之间是锐利的棱线，倒角条带接住高光，形成金属件常见的亮边。
 *  - 金属：金属度 1、低粗糙度 + 粗糙度变化贴图；环境反射用程序生成的摄影棚 HDR（studioEnv.ts）。
 *  - 透明塑料：边缘（掠射角）和高光处自动变得更不透明，表现厚度与边缘反射；内部加强筋透过底盘可见。
 *
 * 只生成外观。碰撞体仍是 BeyPhysics 里按部件参数建的圆柱，外形控制在
 * 碰撞半径 × 1.03、碰撞厚度 × 1.25 以内（tests/visual-bounds.test.ts 检查）。
 * 底面在本地 y = 0，形状 5 重旋转对称（形心在转轴上，旋转时不显得偏心）。
 */

const TAU = Math.PI * 2;

// ───────────────────────── 爪刃几何 ─────────────────────────

interface ClawSpec {
  /** 刃根所在角度（后端内尖在它后方） */
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
 * 一枚爪刃：沿弧形中线密集排布截面，相邻截面连成曲面。
 * 截面（从内到外）：内侧壁 → 内倒角 → 内侧大切面（中间一道浅折线，分成两个切面）→ 脊线倒角 → 外侧陡切面 → 外倒角 → 外侧壁 → 底面。
 * 两端截面收成一点，形成尖端。t ∈ [-0.12, 0] 为后端内尖，t ∈ [0, 1] 为刃身（1 = 前端刃尖）。
 */
function clawGeometry(R: number, H: number, c: ClawSpec, dir: number, pos: number[], uv: number[]): void {
  const ts: number[] = [];
  for (let i = 0; i <= 4; i++) ts.push(-0.12 + (0.12 * i) / 4);
  // 刃身前段（收尖处）采样更密，曲面过渡更顺
  for (let i = 1; i <= 22; i++) ts.push(1 - Math.pow(1 - i / 22, 1.35));

  const widthAt = (t: number) => {
    if (t < 0) return 0.95 * Math.pow((t + 0.12) / 0.12, 0.75);
    if (t < 0.6) return 0.95 + 0.05 * (t / 0.6);
    const q = (t - 0.6) / 0.4;
    return (1 - 0.55 * q) * Math.sqrt(Math.max(0, 1 - Math.pow(q, 5)));
  };
  const radiusAt = (t: number) => {
    if (t < 0) return c.rTail + (c.rRoot - c.rTail) * ((t + 0.12) / 0.12);
    const e = t * t * (3 - 2 * t);
    return c.rRoot + (c.rTip - c.rRoot) * e;
  };
  const ridgeAt = (t: number) => {
    const base = c.yBase + (c.yRidge - c.yBase) * 0.75;
    if (t < 0) return c.yBase + (base - c.yBase) * (0.8 + 0.2 * ((t + 0.12) / 0.12));
    // 脊线在刃身中段最高，前端下降形成刃尖
    const up = Math.min(1, t / 0.55);
    const down = t > 0.7 ? Math.pow((t - 0.7) / 0.3, 1.4) : 0;
    return c.yBase + (c.yRidge - c.yBase) * (0.75 + 0.25 * up) - (c.yRidge - c.yTip) * down;
  };

  const center = (t: number) => {
    const a = c.a0 + dir * c.span * t;
    const r = R * radiusAt(t);
    return new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r);
  };
  const ch = R * 0.016; // 倒角宽度
  const secs: THREE.Vector3[][] = ts.map((t) => {
    const p = center(t);
    const p2 = center(Math.min(1, t + 0.01));
    const p0 = center(Math.max(-0.12, t - 0.01));
    const fwd = p2.sub(p0).normalize();
    let side = new THREE.Vector3(-fwd.z, 0, fwd.x);
    if (side.dot(p) < 0) side.multiplyScalar(-1); // 指向外侧
    const w = R * c.width * widthAt(t);
    const rid = ridgeAt(t);
    const yR = H * rid;
    const yEdge = H * (c.yBase + (rid - c.yBase) * 0.3);
    const yIn = H * (c.yBase + (rid - c.yBase) * 0.45);
    const yB = H * c.yBase;
    const outerW = w * 0.42;
    const innerW = w * 0.58;
    const ridgeShift = w * 0.12;
    // 内侧大切面中间的浅折线（略高于两端连线），形成两个切面
    const midS = (-innerW + ridgeShift) / 2;
    const midY = (yIn + yR) / 2 + H * 0.08 * Math.min(1, w / (R * 0.1));
    // 截面二维点 [横向偏移, 高度]，从内侧底开始逆时针绕一圈
    const prof: [number, number][] = [
      [-innerW, yB],
      [-innerW, yIn],
      [midS, midY],
      [ridgeShift, yR],
      [outerW, yEdge],
      [outerW, yB],
    ];
    // 顶面三条棱（内上棱、脊、外上棱）倒角；折线和底部两个角保持锐利
    const cf = chamfer(prof, Math.min(ch, w * 0.12), [1, 3, 4]);
    return cf.map(([s, y]) => p.clone().addScaledVector(side, s).setY(y));
  });

  const nPts = secs[0].length;
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  const tri = (
    a: THREE.Vector3,
    b: THREE.Vector3,
    d: THREE.Vector3,
    ua: [number, number],
    ub: [number, number],
    ud: [number, number],
    want: THREE.Vector3,
  ) => {
    ab.subVectors(b, a);
    ac.subVectors(d, a);
    nrm.crossVectors(ab, ac);
    if (nrm.lengthSq() < 1e-16) return;
    const flip = nrm.dot(want) < 0;
    const P3 = flip ? [a, d, b] : [a, b, d];
    const U = flip ? [ua, ud, ub] : [ua, ub, ud];
    for (let k = 0; k < 3; k++) {
      pos.push(P3[k].x, P3[k].y, P3[k].z);
      uv.push(U[k][0], U[k][1]);
    }
  };
  for (let i = 0; i < secs.length - 1; i++) {
    const s = secs[i];
    const e = secs[i + 1];
    const u0 = (ts[i] + 0.12) * 2;
    const u1 = (ts[i + 1] + 0.12) * 2;
    // 截面中心：用于判断每个面应朝外的方向
    const cs = s.reduce((acc, v) => acc.add(v), new THREE.Vector3()).multiplyScalar(1 / nPts);
    const ce = e.reduce((acc, v) => acc.add(v), new THREE.Vector3()).multiplyScalar(1 / nPts);
    const cMid = cs.add(ce).multiplyScalar(0.5);
    for (let j = 0; j < nPts; j++) {
      const j2 = (j + 1) % nPts;
      const v0 = j / nPts;
      const v1 = (j + 1) / nPts;
      const mid = new THREE.Vector3().add(s[j]).add(s[j2]).add(e[j]).add(e[j2]).multiplyScalar(0.25);
      const want = mid.sub(cMid);
      tri(s[j], e[j], e[j2], [u0, v0], [u1, v0], [u1, v1], want);
      tri(s[j], e[j2], s[j2], [u0, v0], [u1, v1], [u0, v1], want);
    }
  }
}

/** 刃根安装座：每枚爪的后端下方一块倒角的银色连接块，把爪刃“固定”在骨架外圈上 */
function mountGeometry(R: number, H: number, a: number, pos: number[], uv: number[]): void {
  const r0 = R * 0.6;
  const r1 = R * 0.74;
  const half = 0.07;
  const y0 = H * 0.22;
  const y1 = H * 0.36;
  const shape = new THREE.Shape();
  const pts = [P(r0, a - half * 0.8), P(r1, a - half), P(r1, a + half), P(r0, a + half * 0.8)];
  shape.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i].x, pts[i].y);
  shape.closePath();
  const bev = R * 0.012;
  const geo = new THREE.ExtrudeGeometry(shape, { depth: y1 - y0 - bev * 2, bevelEnabled: true, bevelThickness: bev, bevelSize: bev, bevelSegments: 1, curveSegments: 4 });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, y0 + bev, 0);
  const p = geo.getAttribute('position');
  const u = geo.getAttribute('uv');
  for (let i = 0; i < p.count; i++) {
    pos.push(p.getX(i), p.getY(i), p.getZ(i));
    uv.push(u.getX(i) * 4, u.getY(i) * 4);
  }
}

// ───────────────────────── 组装 ─────────────────────────

export function buildGaleBlade(spec: BladeSpec): THREE.Group {
  const g = new THREE.Group();
  g.name = `blade:${spec.id}`;
  const R = spec.radius;
  const H = spec.height;
  // 右旋 = 俯视顺时针，刃尖朝旋转前进方向；左旋时镜像
  const dir = spec.spin === 'left' ? -1 : 1;

  const mMetal = polishedMetal();
  const mSatin = satinMetal();
  const mBlue = bluePlastic();
  const mDark = darkPlastic();

  // 1) 蓝色透明底盘：底面三级同心台阶，外缘略向上收；内部 10 条加强筋透过底盘可见
  const plate = lathe(
    chamfer(
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
      R * 0.008,
    ),
    72,
  );
  const ribs: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * TAU + (dir * TAU) / 20;
    // 顶面 0.218H，略低于小爪底面 0.22H（共面会在透明底盘里闪烁；外观无变化）
    const rib = new THREE.BoxGeometry(R * 0.4, H * 0.118, R * 0.022);
    rib.translate(R * 0.64, H * 0.159, 0);
    rib.rotateY(-a);
    ribs.push(rib);
  }
  g.add(mesh(merge([plate, ...ribs]), mBlue, 0, 1));

  // 2) 银色外环带：圆滑的金属带，上沿倒角
  g.add(
    mesh(
      lathe(
        chamfer(
          [
            [R * 0.84, H * 0.14],
            [R * 0.95, H * 0.14],
            [R * 0.965, H * 0.21],
            [R * 0.95, H * 0.28],
            [R * 0.85, H * 0.3],
          ],
          R * 0.006,
        ),
        96,
      ),
      mMetal,
    ),
  );

  // 3) 银色爪刃 + 刃根安装座：5 大 5 小交替，窄而尖、沿旋转方向前掠，爪与爪之间留缝露出蓝色骨架
  const cPos: number[] = [];
  const cUv: number[] = [];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * TAU;
    clawGeometry(R, H, { a0: a, span: 0.6, rTail: 0.56, rRoot: 0.66, rTip: 0.965, width: 0.25, yBase: 0.24, yRidge: 1.18, yTip: 0.7 }, dir, cPos, cUv);
    clawGeometry(R, H, { a0: a + (dir * TAU) / 10, span: 0.44, rTail: 0.64, rRoot: 0.72, rTip: 0.93, width: 0.17, yBase: 0.22, yRidge: 0.95, yTip: 0.55 }, dir, cPos, cUv);
    mountGeometry(R, H, a + dir * 0.04, cPos, cUv);
  }
  g.add(mesh(creased(cPos, cUv), mMetal));

  // 4) 蓝色透明骨架：内环 + 8 根辐条 + 8 个镂空窗，圆角倒边
  const frame = new THREE.Shape();
  frame.absarc(0, 0, R * 0.7, 0, TAU, false);
  const hole = new THREE.Path();
  hole.absarc(0, 0, R * 0.36, 0, TAU, true);
  frame.holes.push(hole);
  for (let i = 0; i < 8; i++) {
    const a0 = (i / 8) * TAU + 0.12;
    const a1 = ((i + 1) / 8) * TAU - 0.12;
    const win = new THREE.Path();
    const steps = 8;
    const pts: THREE.Vector2[] = [];
    for (let k = 0; k <= steps; k++) pts.push(P(R * 0.62, a0 + ((a1 - a0) * k) / steps));
    for (let k = steps; k >= 0; k--) pts.push(P(R * 0.44, a0 + 0.03 + ((a1 - a0 - 0.06) * k) / steps));
    win.setFromPoints(pts);
    frame.holes.push(win);
  }
  g.add(mesh(slab(frame, H * 0.4, R * 0.018), mBlue, H * 0.3, 2));

  // 5) 机械细节（缎面金属）：8 颗辐条螺丝 + 滚花压圈
  const satinParts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU;
    // 螺丝头底面埋进骨架 0.002H（与透明骨架顶面共面会闪烁）；顶面位置不变
    const head = new THREE.CylinderGeometry(R * 0.03, R * 0.034, H * 0.052, 16);
    head.translate(Math.cos(a) * R * 0.53, H * 0.724, Math.sin(a) * R * 0.53);
    satinParts.push(head);
  }
  // 滚花压圈：48 齿的齿形圈，齿顶倒角
  const knurl = new THREE.Shape();
  const teeth = 36;
  for (let k = 0; k < teeth * 2; k++) {
    const a = (k / (teeth * 2)) * TAU;
    const r = k % 2 === 0 ? R * 0.395 : R * 0.382;
    const p = P(r, a);
    if (k === 0) knurl.moveTo(p.x, p.y);
    else knurl.lineTo(p.x, p.y);
  }
  knurl.closePath();
  const kh = new THREE.Path();
  kh.absarc(0, 0, R * 0.352, 0, TAU, true);
  knurl.holes.push(kh);
  const ring = slab(knurl, H * 0.08, R * 0.004, 1, 36);
  ring.translate(0, H * 0.77, 0);
  satinParts.push(ring);
  g.add(mesh(merge(satinParts), mSatin));

  // 6) 深色件：徽标座 + 螺丝内六角孔 + 接缝暗线（外环带与底盘、骨架外沿）
  const darkParts: THREE.BufferGeometry[] = [];
  darkParts.push(lathe(chamfer([[R * 0.3, H * 0.4], [R * 0.4, H * 0.4], [R * 0.4, H * 0.74], [R * 0.37, H * 0.8], [R * 0.3, H * 0.8]], R * 0.006, [2, 3]), 64));
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU;
    const hex = new THREE.CylinderGeometry(R * 0.013, R * 0.013, H * 0.012, 6);
    hex.translate(Math.cos(a) * R * 0.53, H * 0.751, Math.sin(a) * R * 0.53);
    darkParts.push(hex);
  }
  for (const [r, y] of [
    [R * 0.845, H * 0.3],
    [R * 0.7, H * 0.7],
    [R * 0.405, H * 0.77],
  ] as const) {
    const seam = new THREE.TorusGeometry(r, R * 0.004, 3, 72);
    seam.rotateX(Math.PI / 2);
    seam.translate(0, y, 0);
    darkParts.push(seam);
  }
  g.add(mesh(merge(darkParts), mDark));

  // 7) 原创徽标（带清漆的印刷贴片）+ 透明护罩
  const emblemMat = galeEmblem();
  const emblem = new THREE.Mesh(new THREE.CircleGeometry(R * 0.355, 64), emblemMat);
  emblem.rotation.x = -Math.PI / 2;
  // 徽标随旋转方向镜像，前掠方向与刀刃一致
  if (dir < 0) emblem.scale.x = -1;
  emblem.position.y = H * 0.805;
  g.add(emblem);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(R * 0.36, 40, 8, 0, TAU, 0, Math.PI / 2), clearDome());
  dome.scale.y = 0.3;
  dome.position.y = H * 0.8;
  dome.renderOrder = 3;
  g.add(dome);
  return g;
}
