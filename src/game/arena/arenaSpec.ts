/**
 * 竞技场规格（原创设计，参考 Xtreme 型场地的结构特征）：
 *  - 中央碗形斜面，陀螺会被重力拉回中心；
 *  - 外缘一圈“极限轨道”（齿轮轨道），齿轮类轴心在此获得冲刺；
 *  - 外墙上开 3 个口袋：1 个极限区口袋（正对玩家的远端）+ 2 个出界口袋（两侧）。
 *
 * 这里只有纯数据和纯函数，渲染与物理分别读取它生成网格和碰撞体。
 */

export type PocketKind = 'xtreme' | 'over';

export interface PocketSpec {
  kind: PocketKind;
  /** 口袋中心角（弧度），x = r·cosθ，z = r·sinθ */
  angle: number;
  /** 口袋开口宽度（弧长方向，单位：游戏单位） */
  width: number;
  /** 口袋深度（向外延伸） */
  depth: number;
  /** 口袋底比场地边缘低多少 */
  drop: number;
}

export interface ArenaSpec {
  /** 碗形场地半径（墙内侧） */
  radius: number;
  /** 碗形曲率 h(r) = bowl·r² */
  bowl: number;
  /** 中心平台半径（这一圈内稍平） */
  centerFlat: number;
  wallHeight: number;
  wallThickness: number;
  /** 极限轨道的内外半径 */
  railInner: number;
  railOuter: number;
  pockets: PocketSpec[];
}

export const ARENA: ArenaSpec = {
  radius: 4.6,
  bowl: 0.052,
  centerFlat: 0.6,
  wallHeight: 1.1,
  wallThickness: 0.3,
  railInner: 4.0,
  railOuter: 4.6,
  pockets: [
    { kind: 'xtreme', angle: -Math.PI / 2, width: 2.3, depth: 1.7, drop: 0.55 },
    { kind: 'over', angle: Math.PI / 6, width: 1.6, depth: 1.3, drop: 0.5 },
    { kind: 'over', angle: (5 * Math.PI) / 6, width: 1.6, depth: 1.3, drop: 0.5 },
  ],
};

/** 场地表面高度：中心有一小块平台，往外是抛物线碗面 */
export function floorHeight(r: number, spec: ArenaSpec = ARENA): number {
  const e = Math.max(0, r - spec.centerFlat);
  return spec.bowl * (e * e + 2 * spec.centerFlat * e) + 0.004 * r * r;
}

/** 场地表面法线（向上） */
export function floorNormal(x: number, z: number, spec: ArenaSpec = ARENA): [number, number, number] {
  const r = Math.hypot(x, z);
  if (r < 1e-6) return [0, 1, 0];
  const d = 0.001;
  const slope = (floorHeight(r + d, spec) - floorHeight(r - d, spec)) / (2 * d);
  const nx = (-slope * x) / r;
  const nz = (-slope * z) / r;
  const len = Math.hypot(nx, 1, nz);
  return [nx / len, 1 / len, nz / len];
}

/** 把角度规整到 (-π, π] */
export function wrapAngle(a: number): number {
  let x = a;
  while (x <= -Math.PI) x += Math.PI * 2;
  while (x > Math.PI) x -= Math.PI * 2;
  return x;
}

/** 给定角度是否落在某个口袋的开口内，返回该口袋 */
export function pocketAtAngle(angle: number, spec: ArenaSpec = ARENA): PocketSpec | undefined {
  return spec.pockets.find((p) => {
    const half = p.width / spec.radius / 2;
    return Math.abs(wrapAngle(angle - p.angle)) <= half;
  });
}

/** 墙内碗面边缘高度 */
export function rimHeight(spec: ArenaSpec = ARENA): number {
  return floorHeight(spec.radius, spec);
}
