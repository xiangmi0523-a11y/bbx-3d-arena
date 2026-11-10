import { getPart } from './catalog';
import type { BeyLoadout, BeyRole, BitSpec, BladeSpec, RatchetSpec } from './types';

/**
 * 组装结果：把三个部件按从下到上的顺序堆叠（Bit → Ratchet → Blade），算出每层在陀螺本地坐标中的位置。
 * 本地坐标原点 = 轴尖最底部（与地面接触点），Y 轴向上。
 * 渲染层和物理层都用这份布局，但各自生成自己的网格 / 碰撞体。
 * 总高度 = 三件高度简单相加（v2.0 §4.2：无嵌套系数）。
 */
export interface StackLayer {
  /** 本层底部 y */
  bottom: number;
  /** 本层顶部 y */
  top: number;
  /** 本层中心 y */
  center: number;
}

export interface AssembledBey {
  loadout: BeyLoadout;
  blade: BladeSpec;
  ratchet: RatchetSpec;
  bit: BitSpec;
  layers: { bit: StackLayer; ratchet: StackLayer; blade: StackLayer };
  /** 陀螺类型（由 Bit 决定） */
  role: BeyRole;
  totalMass: number;
  totalHeight: number;
  /** 最大外径（碰撞外沿） */
  outerRadius: number;
  /** 发射时的最大转速（rad/s），由重量和部件决定 */
  maxSpin: number;
  /** 绕转轴的转动惯量（游戏层标量，v1 全部自转规则以它为准，见 docs/engineering/physics-state-ownership.md） */
  spinInertia: number;
}

/** 转动惯量的参考值（约等于默认组合），转速衰减和撞击掉速都按 参考值 / 实际值 缩放 */
export const REF_INERTIA = 0.55;

function layer(bottom: number, height: number): StackLayer {
  return { bottom, top: bottom + height, center: bottom + height / 2 };
}

export function assembleBey(loadout: BeyLoadout): AssembledBey {
  const blade = getPart('blade', loadout.blade);
  const ratchet = getPart('ratchet', loadout.ratchet);
  const bit = getPart('bit', loadout.bit);

  const bitLayer = layer(0, bit.height);
  const ratchetLayer = layer(bitLayer.top, ratchet.height);
  const bladeLayer = layer(ratchetLayer.top, blade.height);
  const totalMass = blade.mass + ratchet.mass + bit.mass;

  return {
    loadout: { blade: loadout.blade, ratchet: loadout.ratchet, bit: loadout.bit },
    blade,
    ratchet,
    bit,
    layers: { bit: bitLayer, ratchet: ratchetLayer, blade: bladeLayer },
    role: bit.role,
    totalMass,
    totalHeight: bladeLayer.top,
    outerRadius: Math.max(blade.radius, ratchet.radius),
    // 越重转速上限略低，但惯量更大
    maxSpin: 170 - (totalMass - 4) * 6,
    spinInertia:
      blade.mass * blade.radius * blade.radius * blade.rimWeight +
      ratchet.mass * ratchet.radius * ratchet.radius * ratchet.rimWeight +
      bit.mass * bit.contactRadius * bit.contactRadius * 0.5,
  };
}

/** 替换单个部件，返回新的组装方案（不修改原对象） */
export function swapPart(loadout: BeyLoadout, kind: keyof BeyLoadout, id: string): BeyLoadout {
  return { ...loadout, [kind]: id };
}

export interface BeyStats {
  attack: number;
  defense: number;
  stamina: number;
  mobility: number;
  weight: number;
  /** 抗爆：lock × burstGuard（相对全部组合的最大值） */
  burst: number;
}

/** 抗爆组合 lock × burstGuard 的最大可能值（圆环护轮 0.85 × 橡胶轴 0.9），用于把抗爆显示成 0..1 */
const BURST_MAX = 0.85 * 0.9;

/**
 * 展示用四维属性（0..1，v2.0 §4.4 公式；只给 UI，不参与物理）。
 * 公式的正确性以“展示排序与实测对局表现排序一致”验收（S3），不一致时改公式，不改物理参数迎合展示。
 */
export function computeStats(b: AssembledBey): BeyStats {
  const c = (v: number) => Math.max(0.04, Math.min(1, v));
  return {
    attack: c(b.blade.attack * 0.6 + b.bit.gearGrip * 0.25 + b.blade.rimWeight * 0.15),
    defense: c(b.blade.defense * 0.5 + b.ratchet.lock * 0.3 + (b.totalMass / 5.5) * 0.2),
    stamina: c(((2.2 - b.bit.spinDecay) / 1.4) * 0.7 + b.blade.rimWeight * 0.3),
    mobility: c(b.bit.gearGrip * 0.6 + b.bit.drift * 2.0 * 0.2 + b.blade.friction * 0.2),
    weight: c((b.totalMass - 3.8) / 1.8),
    burst: c((b.ratchet.lock * b.bit.burstGuard) / BURST_MAX),
  };
}

export function partMass(b: AssembledBey): string {
  return `${(b.totalMass * 8.5).toFixed(1)} g`;
}
