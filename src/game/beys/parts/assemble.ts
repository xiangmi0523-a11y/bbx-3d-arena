import { getPart } from './catalog';
import type { BeyLoadout, BladeSpec, DiscSpec, TipSpec } from './types';

/**
 * 组装结果：把三个部件按从下到上的顺序堆叠，算出每层在陀螺本地坐标中的位置。
 * 本地坐标原点 = 轴心最底部（与地面接触点），Y 轴向上。
 * 渲染层和物理层都用这份布局，但各自生成自己的网格 / 碰撞体。
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
  disc: DiscSpec;
  tip: TipSpec;
  layers: { tip: StackLayer; disc: StackLayer; blade: StackLayer };
  totalMass: number;
  totalHeight: number;
  /** 最大外径（碰撞外沿） */
  outerRadius: number;
  /** 发射时的最大转速（rad/s），由重量和部件决定 */
  maxSpin: number;
}

function layer(bottom: number, height: number): StackLayer {
  return { bottom, top: bottom + height, center: bottom + height / 2 };
}

export function assembleBey(loadout: BeyLoadout): AssembledBey {
  const blade = getPart('blade', loadout.blade);
  const disc = getPart('disc', loadout.disc);
  const tip = getPart('tip', loadout.tip);

  const tipLayer = layer(0, tip.height);
  const discLayer = layer(tipLayer.top, disc.height);
  const bladeLayer = layer(discLayer.top, blade.height);
  const totalMass = blade.mass + disc.mass + tip.mass;

  return {
    loadout: { ...loadout },
    blade,
    disc,
    tip,
    layers: { tip: tipLayer, disc: discLayer, blade: bladeLayer },
    totalMass,
    totalHeight: bladeLayer.top,
    outerRadius: Math.max(blade.radius, disc.radius),
    // 越重转速上限略低，但惯量更大
    maxSpin: 170 - (totalMass - 4) * 6,
  };
}

/** 替换单个部件，返回新的组装方案（不修改原对象） */
export function swapPart(loadout: BeyLoadout, kind: keyof BeyLoadout, id: string): BeyLoadout {
  return { ...loadout, [kind]: id };
}
