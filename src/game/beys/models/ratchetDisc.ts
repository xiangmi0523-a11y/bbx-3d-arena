import * as THREE from 'three';
import { P, chamfer, lathe, merge, mesh, slab } from './geom';
import { bluePlastic, navyPlastic, satinMetal } from './materials';
import type { RatchetSpec } from '../parts/types';

/**
 * 锁齿式 Ratchet（P2.3 阶段 2，首个是「六齿棘轮」hex-lock），与疾风新月 Blade 同一套设计语言。
 *
 * 结构（从下到上；本地 y = 0 为 Ratchet 底面，H 为 Ratchet 层厚）：
 *  1. 下部裙边（深蓝不透明注塑件，y 0 → 0.5H）：外轮廓是 N 个凸起 + 凸起之间的防滑竖筋；
 *     中央是 Bit 的插口，插口边缘有 3 个卡口缺口，正对 Bit 外壳上的 3 个卡扣；
 *     每个凸起底下挖空（注塑件常见的减料空腔），空腔中间留一道加强筋。
 *  2. 上部透明蓝罩层（与 Blade 同一种透明蓝，y 0.5H → H）：比裙边内缩一圈，形成合模线台阶；
 *     透过它能看到里面的深蓝轮毂管和 12 道放射加强筋。
 *  3. 顶面：外圈支承环（顶住 Blade 底面，Blade 不悬空）+ 内圈锁齿座和 N 枚棘齿形锁齿
 *     （斜面 + 直角止挡，按右旋方向排列），锁齿伸进 Blade 底部中央的凹槽，不碰到 Blade；
 *     中心是缎面金属衬套（唯一的金属件，连接用途）。
 *
 * 以上是游戏内的设计，参考了实物陀螺“塑料锁齿 + 卡口装配”的结构逻辑，尺寸和齿形不是任何实物零件的复刻。
 * 只生成外观；碰撞体仍是 BeyPhysics 里按 radius / height 建的圆柱（tests/visual-bounds.test.ts 检查范围）。
 */

const TAU = Math.PI * 2;

/** 支承环顶面：Blade 底面外圈台阶在 0.0114（0.06H_b），留 0.0008 不与 Blade 透明底盘共面（共面会闪烁），视觉上是贴合 */
const BLADE_SEAT = 0.0106;
/** 锁齿最高点：不超过视觉护栏允许的 0.02，并给 Blade 中心凹槽（深 0.0228）留 0.003 余隙 */
const TOOTH_TOP = 0.0195;
/** 顶面凸台的底面埋进透明罩 0.002：不与透明罩顶面共面（共面会在透明件后面闪烁） */
const EMBED = 0.002;

/** Bit 外壳上卡扣所在的角度（BeyVisualFactory 的 ring(g, 3, …) 从 0 开始均分） */
const CLIP_ANGLES = [0, TAU / 3, (2 * TAU) / 3];

/** 外轮廓关键点（角度、半径），一个凸起 + 一段竖筋间隙为一个扇区 */
function outline(R: number, n: number, ribs: boolean, scale: number): THREE.Vector2[] {
  const pitch = TAU / n;
  const base = 0.8 * R;
  const top = 0.985 * R;
  const rib = 0.022 * R;
  const pts: [number, number][] = [];
  for (let k = 0; k < n; k++) {
    const a0 = k * pitch;
    const at = (u: number) => a0 + u * pitch;
    // 间隙（u -0.2 → 0.2）：三道防滑竖筋
    pts.push([at(-0.2), base]);
    if (ribs) {
      for (const c of [-0.1, 0, 0.1]) {
        pts.push([at(c - 0.022), base], [at(c - 0.012), base + rib], [at(c + 0.012), base + rib], [at(c + 0.022), base]);
      }
    }
    // 凸起（u 0.2 → 0.8）：直线侧翼 + 小倒角 + 略微外凸的顶面
    pts.push([at(0.2), base], [at(0.3), top * 0.975], [at(0.325), top]);
    for (const u of [0.4, 0.5, 0.6]) pts.push([at(u), top * (1 + 0.006 * Math.cos(((u - 0.5) / 0.35) * Math.PI))]);
    pts.push([at(0.675), top], [at(0.7), top * 0.975]);
  }
  return pts.map(([a, r]) => P(r * scale, a));
}

function shapeOf(pts: THREE.Vector2[]): THREE.Shape {
  return new THREE.Shape(pts);
}

function circlePath(r: number, segs: number): THREE.Path {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i < segs; i++) pts.push(P(r, (i / segs) * TAU));
  return new THREE.Path(pts);
}

/** Bit 插口：圆孔 + 3 个卡口缺口（按角度顺序依次走：圆弧 → 缺口一侧直边 → 缺口外沿 → 另一侧直边） */
function socketPath(R: number): THREE.Path {
  const r0 = 0.7 * R;
  const r1 = 0.79 * R;
  const half = 0.15;
  const pts: THREE.Vector2[] = [];
  const m = CLIP_ANGLES.length;
  for (let k = 0; k < m; k++) {
    const c = CLIP_ANGLES[k];
    const next = k + 1 < m ? CLIP_ANGLES[k + 1] : CLIP_ANGLES[0] + TAU;
    // 缺口
    pts.push(P(r0, c - half), P(r1, c - half));
    for (let i = 1; i < 4; i++) pts.push(P(r1, c - half + (2 * half * i) / 4));
    pts.push(P(r1, c + half), P(r0, c + half));
    // 到下一个缺口之间的圆弧
    const a0 = c + half;
    const a1 = next - half;
    const steps = 20;
    for (let i = 1; i < steps; i++) pts.push(P(r0, a0 + ((a1 - a0) * i) / steps));
  }
  return new THREE.Path(pts);
}

/** 凸起底下的减料空腔（每个凸起两格，中间一道加强筋） */
function pocketPaths(R: number, n: number): THREE.Path[] {
  const pitch = TAU / n;
  const out: THREE.Path[] = [];
  for (let k = 0; k < n; k++) {
    for (const [u0, u1] of [
      [0.35, 0.48],
      [0.52, 0.65],
    ]) {
      const a0 = (k + u0) * pitch;
      const a1 = (k + u1) * pitch;
      const pts: THREE.Vector2[] = [];
      const steps = 3;
      for (let i = 0; i <= steps; i++) pts.push(P(0.915 * R, a0 + ((a1 - a0) * i) / steps));
      for (let i = steps; i >= 0; i--) pts.push(P(0.85 * R, a0 + ((a1 - a0) * i) / steps));
      out.push(new THREE.Path(pts));
    }
  }
  return out;
}

/** 一枚棘齿形锁齿：沿旋转方向斜面上升，末端直角止挡 */
function toothGeometry(r0: number, r1: number, a0: number, span: number, y0: number, y1: number, dir: number): THREE.BufferGeometry {
  const steps = 4;
  const pos: number[] = [];
  const pt = (r: number, a: number, y: number) => new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r);
  const push = (...vs: THREE.Vector3[]) => {
    for (const v of vs) pos.push(v.x, v.y, v.z);
  };
  const quad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, want: THREE.Vector3) => {
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    if (n.dot(want) < 0) push(a, c, b, a, d, c);
    else push(a, b, c, a, c, d);
  };
  const ang = (i: number) => a0 + dir * span * (i / steps);
  const hAt = (i: number) => y0 + (y1 - y0) * (0.15 + 0.85 * (i / steps));
  for (let i = 0; i < steps; i++) {
    const aA = ang(i);
    const aB = ang(i + 1);
    const mid = (aA + aB) / 2;
    const up = new THREE.Vector3(0, 1, 0);
    // 斜面
    quad(pt(r0, aA, hAt(i)), pt(r1, aA, hAt(i)), pt(r1, aB, hAt(i + 1)), pt(r0, aB, hAt(i + 1)), up);
    // 外、内侧壁
    quad(pt(r1, aA, y0), pt(r1, aB, y0), pt(r1, aB, hAt(i + 1)), pt(r1, aA, hAt(i)), new THREE.Vector3(Math.cos(mid), 0, Math.sin(mid)));
    quad(pt(r0, aA, y0), pt(r0, aB, y0), pt(r0, aB, hAt(i + 1)), pt(r0, aA, hAt(i)), new THREE.Vector3(-Math.cos(mid), 0, -Math.sin(mid)));
  }
  // 起点低端面、末端直角止挡面
  const tang = (a: number) => new THREE.Vector3(-Math.sin(a), 0, Math.cos(a)).multiplyScalar(dir);
  quad(pt(r0, ang(0), y0), pt(r1, ang(0), y0), pt(r1, ang(0), hAt(0)), pt(r0, ang(0), hAt(0)), tang(ang(0)).negate());
  quad(pt(r0, ang(steps), y0), pt(r1, ang(steps), y0), pt(r1, ang(steps), hAt(steps)), pt(r0, ang(steps), hAt(steps)), tang(ang(steps)));
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}

export function buildRatchetDisc(spec: RatchetSpec): THREE.Group {
  const g = new THREE.Group();
  g.name = `ratchet:${spec.id}`;
  const R = spec.radius;
  const H = spec.height;
  const n = Math.max(3, spec.teeth);
  // 现有 Blade 全部右旋；锁齿方向按右旋排列
  const dir = 1;

  const mNavy = navyPlastic();
  const mBlue = bluePlastic();
  const mSatin = satinMetal();

  const navy: THREE.BufferGeometry[] = [];

  // 1) 下部裙边：外轮廓（带竖筋）− Bit 插口 − 凸起空腔
  const skirt = shapeOf(outline(R, n, true, 1));
  skirt.holes.push(socketPath(R), ...pocketPaths(R, n));
  navy.push(slab(skirt, H * 0.5, R * 0.012, 1, 12));

  // 2) 罩层内部结构（深蓝，透过透明罩可见）：轮毂管 + 12 道放射加强筋
  navy.push(lathe(chamfer([[0.35 * R, H * 0.5], [0.44 * R, H * 0.5], [0.44 * R, H * 0.985], [0.35 * R, H * 0.985]], R * 0.008, [2, 3]), 40));
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU + TAU / 24;
    const rib = new THREE.BoxGeometry(0.34 * R, H * 0.42, 0.035 * R);
    rib.translate(0.61 * R, H * 0.73, 0);
    rib.rotateY(-a);
    navy.push(rib);
  }

  // 3) 顶面：外圈支承环（顶面正好贴住 Blade 底面外圈台阶）
  navy.push(
    lathe(
      chamfer(
        [
          [0.7 * R, H - EMBED],
          [0.78 * R, H - EMBED],
          [0.78 * R, H + BLADE_SEAT],
          [0.7 * R, H + BLADE_SEAT],
        ],
        R * 0.006,
        [2, 3],
      ),
      48,
    ),
  );
  // 锁齿座 + N 枚棘齿
  const seat = H + 0.004;
  navy.push(lathe(chamfer([[0.37 * R, H - EMBED], [0.66 * R, H - EMBED], [0.66 * R, seat], [0.37 * R, seat]], R * 0.004, [2, 3]), 48));
  const pitch = TAU / n;
  for (let k = 0; k < n; k++) navy.push(toothGeometry(0.42 * R, 0.63 * R, k * pitch + pitch * 0.2, pitch * 0.55, seat, H + TOOTH_TOP, dir));
  g.add(mesh(merge(navy), mNavy));

  // 4) 上部透明蓝罩层：比裙边内缩 1.5%，形成合模线台阶；中间留轴孔
  const cap = shapeOf(outline(R, n, false, 0.985));
  cap.holes.push(circlePath(0.37 * R, 32));
  // 顶面比层顶低 0.0005：旧款 Blade 的平底正好落在层顶，避免与透明罩顶面共面闪烁
  const capGeo = slab(cap, H * 0.5 - 0.0015, R * 0.01, 1, 12);
  capGeo.translate(0, H * 0.5 + 0.001, 0);
  // 透明件绘制顺序：Ratchet 罩层（0）在 Blade 底盘（1）之前
  g.add(mesh(capGeo, mBlue, 0, 0));

  // 5) 缎面金属衬套：连接 Bit 轴与 Blade 的唯一金属件，顶端伸进 Blade 中心孔
  g.add(
    mesh(
      lathe(
        chamfer(
          [
            [0.335 * R, H * 0.55],
            [0.385 * R, H * 0.55],
            [0.385 * R, H + 0.012],
            [0.335 * R, H + 0.012],
          ],
          R * 0.006,
          [2, 3],
        ),
        32,
      ),
      mSatin,
    ),
  );
  return g;
}
