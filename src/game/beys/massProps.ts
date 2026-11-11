import type { AssembledBey } from './parts/assemble';

/**
 * 陀螺刚体的质量属性（解析）：与 BeyPhysics 创建的碰撞体逐一对应（形状、质量、位置完全相同），按 Rapier / parry 的公式计算：
 *  - 圆柱（沿本地 y 轴，半高 hh、半径 r、质量 m）：Iy = m r² / 2，Ix = Iz = m (3r² + (2hh)²) / 12；
 *  - 球（半径 r）：I = 2/5 m r²；
 *  - 刚体：质心在本地 y 轴上（全部碰撞体同轴叠放），绕质心的横轴惯量按平行轴定理叠加。
 * 结果是轴对称张量：转轴 Ia、横轴 It。用于重击模型（clawStrike）的有效质量与能量审计；
 * CI 测试（tests/clawPhysics.test.ts）用 Rapier 的实际冲量响应逐项核对，防止与碰撞体布局漂移。
 * 纯函数，不调用 Rapier，不改变任何物理状态。
 */
export interface MassProps {
  mass: number;
  /** 质心在本地 y 轴上的高度（相对刚体原点） */
  comY: number;
  /** 绕转轴 / 横轴的转动惯量（绕质心） */
  Ia: number;
  It: number;
}

/** BeyPhysics 的轴杆圆柱半径（与 BeyPhysics 构造函数一致） */
export const SHAFT_RADIUS = 0.11;
/** Bit 的质量在接地球与轴杆之间的分配（与 BeyPhysics 构造函数一致） */
export const BIT_BALL_SHARE = 0.6;

interface Part {
  m: number;
  y: number;
  ia: number;
  it: number;
}

export function beyMassProps(spec: AssembledBey, opts: { withBlade?: boolean } = {}): MassProps {
  const { bit, ratchet, blade, layers } = spec;
  const parts: Part[] = [];
  const cyl = (m: number, hh: number, r: number, y: number) => parts.push({ m, y, ia: (m * r * r) / 2, it: (m * (3 * r * r + 4 * hh * hh)) / 12 });
  // 接地球
  const rb = bit.contactRadius;
  const mb = bit.mass * BIT_BALL_SHARE;
  parts.push({ m: mb, y: rb, ia: 0.4 * mb * rb * rb, it: 0.4 * mb * rb * rb });
  // 轴杆
  const shaftH = Math.max(0.02, layers.bit.top - rb);
  cyl(bit.mass * (1 - BIT_BALL_SHARE), shaftH / 2, SHAFT_RADIUS, rb + shaftH / 2);
  // Ratchet、Blade
  cyl(ratchet.mass, ratchet.height / 2, ratchet.radius, layers.ratchet.center);
  if (opts.withBlade !== false) cyl(blade.mass, blade.height / 2, blade.radius, layers.blade.center);
  const mass = parts.reduce((s, p) => s + p.m, 0);
  const comY = parts.reduce((s, p) => s + p.m * p.y, 0) / mass;
  const Ia = parts.reduce((s, p) => s + p.ia, 0);
  const It = parts.reduce((s, p) => s + p.it + p.m * (p.y - comY) * (p.y - comY), 0);
  return { mass, comY, Ia, It };
}
