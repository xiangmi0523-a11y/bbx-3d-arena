import * as THREE from 'three';
import { P, chamfer, creased, lathe, merge, mesh, slab } from './geom';
import { clawGeometry, mountGeometry, type ClawSpec } from './galeBlade';
import { clearDome, darkPlastic, polishedMetal, satinMetal, typeEmblem, typePlastic } from './materials';
import type { BeyRole, BladeSpec, BladeStyle } from '../parts/types';

/**
 * M6：按《产品设计总方案与 Claude 设计任务书》的概念板视觉语言重制的 Blade（全部原创造型）。
 *
 * 概念板的共同语言：银色多面切削金属刃 + 类型色透明骨架 + 深色徽标座与类型徽标 + 低矮透明护罩；
 * 攻击 红 / 防守 蓝 / 平衡 绿 / 耐力 紫。与已验收的「疾风新月」（galeBlade.ts）同一套结构与材质，
 * 俯视轮廓按工程图纸（diagrams/bey-*.svg，图纸生成器 blade_points）的参数化公式：
 *   烈焰獠牙 3 瓣 · 尖锐 1.1 · 前掠 0.65 · 谷深比 0.60（方向性大獠牙，攻击识别度最强）
 *   潮汐堡垒 6 瓣 · 尖锐 2.6 · 前掠 0    · 谷深比 0.88（厚实连续护甲，低突出）
 *   泰坦王冠 4 瓣 · 尖锐 1.7 · 前掠 0.10 · 谷深比 0.72（流线低阻轮廓 + 外缘金属配重环）
 * 概念板里的尺寸、文字只作视觉参考，不作工程依据（任务书 §0）；尺寸全部来自部件参数（游戏单位）。
 *
 * 只生成外观：碰撞体仍是 BeyPhysics 按 radius / height 建的圆柱。外形控制在碰撞半径 × 1.03、
 * 碰撞厚度 × 1.25 以内，底面在 y = 0，形状按瓣数旋转对称（tests/visual-bounds.test.ts 检查）。
 * 底盘的底面台阶与疾风新月相同（0.06H / 0.12H），与锁齿式 Ratchet 的支承环、锁齿留有间隙（不穿插、不共面）。
 */

const TAU = Math.PI * 2;

interface Outline {
  lobes: number;
  sharp: number;
  skew: number;
  valley: number;
}

const OUTLINE: Partial<Record<BladeStyle, Outline>> = {
  fang: { lobes: 3, sharp: 1.1, skew: 0.65, valley: 0.6 },
  bastion: { lobes: 6, sharp: 2.6, skew: 0, valley: 0.88 },
  crown: { lobes: 4, sharp: 1.7, skew: 0.1, valley: 0.72 },
};

/** 俯视轮廓半径比（与图纸生成器同一公式）。a 为世界角度，dir 为旋转方向（右旋 +1） */
function outlineAt(o: Outline, a: number, dir: number): number {
  const t = (((dir * a) / TAU) % 1 + 1) % 1;
  const ph = (t * o.lobes) % 1;
  const peak = 0.5 + o.skew * 0.22;
  const d = (((ph - peak + 0.5) % 1) + 1) % 1 - 0.5;
  const prof = Math.pow(Math.max(0, Math.cos(d * Math.PI)), o.sharp);
  return o.valley + (1 - o.valley) * prof;
}

/** 第 k 瓣峰值所在的世界角度 */
function peakAngle(o: Outline, k: number, dir: number): number {
  return (dir * ((k + 0.5 + o.skew * 0.22) / o.lobes) * TAU);
}

/** 按轮廓生成的水平厚片（中间开孔） */
function outlineSlab(o: Outline, R: number, scale: number, hole: number, depth: number, bevel: number, dir: number): THREE.BufferGeometry {
  const n = o.lobes * 40;
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    pts.push(P(R * scale * outlineAt(o, a, dir), a));
  }
  const shape = new THREE.Shape(pts);
  const h = new THREE.Path();
  h.absarc(0, 0, hole, 0, TAU, true);
  shape.holes.push(h);
  return slab(shape, depth, bevel, 2, 12);
}

/** 底盘（与疾风新月相同的底面台阶，外缘半径可调） */
function basePlate(R: number, H: number, outer: number): THREE.BufferGeometry {
  return lathe(
    chamfer(
      [
        [R * 0.24, H * 0.12],
        [R * 0.42, H * 0.12],
        [R * 0.42, H * 0.06],
        [R * 0.62, H * 0.06],
        [R * 0.62, 0],
        [R * (outer - 0.07), 0],
        [R * outer, H * 0.08],
        [R * outer, H * 0.24],
        [R * 0.24, H * 0.3],
      ],
      R * 0.008,
    ),
    72,
  );
}

/** 类型色透明骨架：内环 + windows 个镂空窗 */
function frameGeometry(R: number, H: number, outer: number, windows: number, phase: number): THREE.BufferGeometry {
  const frame = new THREE.Shape();
  frame.absarc(0, 0, R * outer, 0, TAU, false);
  const hole = new THREE.Path();
  hole.absarc(0, 0, R * 0.36, 0, TAU, true);
  frame.holes.push(hole);
  const rOut = R * (outer - 0.08);
  for (let i = 0; i < windows; i++) {
    const gap = 0.7 / windows;
    const a0 = (i / windows) * TAU + phase + gap;
    const a1 = ((i + 1) / windows) * TAU + phase - gap;
    const win = new THREE.Path();
    const steps = 8;
    const pts: THREE.Vector2[] = [];
    for (let k = 0; k <= steps; k++) pts.push(P(rOut, a0 + ((a1 - a0) * k) / steps));
    for (let k = steps; k >= 0; k--) pts.push(P(R * 0.44, a0 + 0.03 + ((a1 - a0 - 0.06) * k) / steps));
    win.setFromPoints(pts);
    frame.holes.push(win);
  }
  return slab(frame, H * 0.4, R * 0.018);
}

/** 中心件：辐条螺丝、滚花压圈、深色徽标座、接缝暗线、类型徽标、透明护罩（与疾风新月相同的做法） */
function addCore(g: THREE.Group, R: number, H: number, role: BeyRole, screws: number, frameOuter: number, dir: number): void {
  const satin: THREE.BufferGeometry[] = [];
  for (let i = 0; i < screws; i++) {
    const a = (i / screws) * TAU;
    const head = new THREE.CylinderGeometry(R * 0.03, R * 0.034, H * 0.052, 16);
    head.translate(Math.cos(a) * R * 0.53, H * 0.724, Math.sin(a) * R * 0.53);
    satin.push(head);
  }
  const knurl = new THREE.Shape();
  const teeth = 36;
  for (let k = 0; k < teeth * 2; k++) {
    const p = P(k % 2 === 0 ? R * 0.395 : R * 0.382, (k / (teeth * 2)) * TAU);
    if (k === 0) knurl.moveTo(p.x, p.y);
    else knurl.lineTo(p.x, p.y);
  }
  knurl.closePath();
  const kh = new THREE.Path();
  kh.absarc(0, 0, R * 0.352, 0, TAU, true);
  knurl.holes.push(kh);
  const ring = slab(knurl, H * 0.08, R * 0.004, 1, 36);
  ring.translate(0, H * 0.77, 0);
  satin.push(ring);
  g.add(mesh(merge(satin), satinMetal()));

  const dark: THREE.BufferGeometry[] = [];
  dark.push(lathe(chamfer([[R * 0.3, H * 0.4], [R * 0.4, H * 0.4], [R * 0.4, H * 0.74], [R * 0.37, H * 0.8], [R * 0.3, H * 0.8]], R * 0.006, [2, 3]), 64));
  for (let i = 0; i < screws; i++) {
    const a = (i / screws) * TAU;
    const hex = new THREE.CylinderGeometry(R * 0.013, R * 0.013, H * 0.012, 6);
    hex.translate(Math.cos(a) * R * 0.53, H * 0.751, Math.sin(a) * R * 0.53);
    dark.push(hex);
  }
  for (const [r, y] of [
    [R * frameOuter, H * 0.7],
    [R * 0.405, H * 0.77],
  ] as const) {
    const seam = new THREE.TorusGeometry(r, R * 0.004, 3, 72);
    seam.rotateX(Math.PI / 2);
    seam.translate(0, y, 0);
    dark.push(seam);
  }
  g.add(mesh(merge(dark), darkPlastic()));

  const emblem = new THREE.Mesh(new THREE.CircleGeometry(R * 0.355, 64), typeEmblem(role));
  emblem.rotation.x = -Math.PI / 2;
  if (dir < 0) emblem.scale.x = -1;
  emblem.position.y = H * 0.805;
  g.add(emblem);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(R * 0.36, 40, 8, 0, TAU, 0, Math.PI / 2), clearDome());
  dome.scale.y = 0.3;
  dome.position.y = H * 0.8;
  dome.renderOrder = 3;
  g.add(dome);
}

export function buildConceptBlade(spec: BladeSpec): THREE.Group {
  const style = spec.visual.style;
  const o = OUTLINE[style];
  if (!o) throw new Error(`没有 ${style} 的概念板造型`);
  const g = new THREE.Group();
  g.name = `blade:${spec.id}`;
  const R = spec.radius;
  const H = spec.height;
  const dir = spec.spin === 'left' ? -1 : 1;
  const role: BeyRole = spec.visual.tint ?? spec.role;
  const mMetal = polishedMetal();
  const mClear = typePlastic(role);

  const metal: THREE.BufferGeometry[] = [];
  const cPos: number[] = [];
  const cUv: number[] = [];
  let frameOuter = 0.7;
  let windows = 8;
  let screws = 8;
  let plateOuter = 0.93;

  if (style === 'fang') {
    // 烈焰獠牙：三枚向前大幅弯折的獠牙 + 三枚尾刺；獠牙之间是深谷（谷深比 0.60），露出红色骨架
    plateOuter = 0.7;
    frameOuter = 0.64;
    windows = 6;
    screws = 6;
    // 银色獠牙板：图纸轮廓本身（决定俯视剪影与接触外缘）
    const plate = outlineSlab(o, R, 0.985, R * 0.42, H * 0.2, R * 0.012, dir);
    plate.translate(0, H * 0.14, 0);
    metal.push(plate);
    for (let k = 0; k < o.lobes; k++) {
      const pk = peakAngle(o, k, dir);
      const big: ClawSpec = { a0: pk - dir * 1.0, span: 1.0, rTail: 0.5, rRoot: 0.6, rTip: 0.975, width: 0.3, yBase: 0.3, yRidge: 1.18, yTip: 0.6 };
      const tail: ClawSpec = { a0: pk - dir * 1.85, span: 0.6, rTail: 0.54, rRoot: 0.62, rTip: 0.8, width: 0.15, yBase: 0.3, yRidge: 0.92, yTip: 0.5 };
      clawGeometry(R, H, big, dir, cPos, cUv);
      clawGeometry(R, H, tail, dir, cPos, cUv);
      mountGeometry(R, H, pk - dir * 0.95, cPos, cUv);
    }
  } else if (style === 'bastion') {
    // 潮汐堡垒：厚实的六段连续金属护甲环（谷深比 0.88，几乎是圆）+ 每段一块低矮装甲片
    frameOuter = 0.68;
    windows = 6;
    screws = 6;
    const armor = outlineSlab(o, R, 0.985, R * 0.66, H * 0.36, R * 0.02, dir);
    armor.translate(0, H * 0.14, 0);
    metal.push(armor);
    for (let k = 0; k < o.lobes; k++) {
      const pk = peakAngle(o, k, dir);
      clawGeometry(R, H, { a0: pk - dir * 0.46, span: 0.84, rTail: 0.72, rRoot: 0.77, rTip: 0.93, width: 0.2, yBase: 0.5, yRidge: 0.92, yTip: 0.76 }, dir, cPos, cUv);
    }
  } else {
    // 泰坦王冠：外缘厚重金属配重环（rimWeight 0.78 的视觉表达）+ 四瓣流线冠片 + 四枚低矮导流鳍
    frameOuter = 0.6;
    windows = 8;
    screws = 8;
    metal.push(
      lathe(
        chamfer(
          [
            [R * 0.84, H * 0.1],
            [R * 0.95, H * 0.1],
            [R * 0.985, H * 0.22],
            [R * 0.975, H * 0.36],
            [R * 0.9, H * 0.44],
            [R * 0.84, H * 0.42],
          ],
          R * 0.01,
        ),
        120,
      ),
    );
    const crown = outlineSlab(o, R, 0.9, R * 0.58, H * 0.18, R * 0.012, dir);
    crown.translate(0, H * 0.4, 0);
    metal.push(crown);
    for (let k = 0; k < o.lobes; k++) {
      const pk = peakAngle(o, k, dir);
      clawGeometry(R, H, { a0: pk - dir * 0.62, span: 0.7, rTail: 0.6, rRoot: 0.66, rTip: 0.86, width: 0.18, yBase: 0.56, yRidge: 0.9, yTip: 0.64 }, dir, cPos, cUv);
    }
  }

  // 1) 类型色透明底盘
  g.add(mesh(basePlate(R, H, plateOuter), mClear, 0, 1));
  // 2) 银色金属：轮廓板 / 护甲环 / 配重环 + 爪刃（多面切削，锐利棱线）
  metal.push(creased(cPos, cUv));
  g.add(mesh(merge(metal), mMetal));
  // 3) 类型色透明骨架
  g.add(mesh(frameGeometry(R, H, frameOuter, windows, dir * (TAU / windows / 2)), mClear, H * 0.3, 2));
  // 4) 中心件与徽标
  addCore(g, R, H, role, screws, frameOuter, dir);
  return g;
}
