/**
 * 陀螺部件数据定义。
 *
 * 一个陀螺 = Blade（攻击环）+ Disc（固锁盘）+ Tip（轴心）。
 * 每个部件同时包含两类彼此独立的数据：
 *  - visual：只给渲染层（Three.js）使用的外观参数；
 *  - 物理参数（尺寸、质量、摩擦等）：只给物理层（Rapier）使用。
 * 渲染层和物理层分别读取自己需要的字段，互不依赖，
 * 后续更换外观模型（例如导入 glTF）不会影响碰撞体，反之亦然。
 */

export type SpinDirection = 'right' | 'left';
export type BeyRole = 'attack' | 'defense' | 'stamina' | 'balance';

/** 所有部件共享的基础字段 */
export interface PartBase {
  id: string;
  name: string;
  /** 英文代号，用于 UI 和存档 */
  code: string;
  /** 质量（游戏单位） */
  mass: number;
}

export type BladeStyle = 'fang' | 'bastion';

export interface BladeVisual {
  style: BladeStyle;
  /** 刃的数量（旋转对称数） */
  lobes: number;
  primary: number;
  secondary: number;
  metal: number;
  accent: number;
}

export interface BladeSpec extends PartBase {
  kind: 'blade';
  role: BeyRole;
  spin: SpinDirection;
  /** 碰撞半径 */
  radius: number;
  /** 碰撞厚度 */
  height: number;
  friction: number;
  restitution: number;
  /** 撞击加成 0..1：碰撞时额外冲量的倍率 */
  attack: number;
  /** 防御 0..1：被撞时冲量减免 */
  defense: number;
  visual: BladeVisual;
}

export interface DiscVisual {
  /** 固锁盘凸起数 */
  points: number;
  color: number;
  accent: number;
}

export interface DiscSpec extends PartBase {
  kind: 'disc';
  radius: number;
  height: number;
  /** 抗爆裂值（P1 预留，P2 爆裂判定使用） */
  burstResistance: number;
  visual: DiscVisual;
}

export type TipShape = 'gear-flat' | 'ball' | 'point';

export interface TipVisual {
  shape: TipShape;
  color: number;
  accent: number;
}

export interface TipSpec extends PartBase {
  kind: 'tip';
  /** 与地面接触的球半径（越大越“抓地”、移动越激烈） */
  contactRadius: number;
  /** 轴心总高度 */
  height: number;
  /** 与场地的摩擦系数 */
  friction: number;
  /** 恒定转速衰减（rad/s²） */
  spinDecay: number;
  /** 齿轮咬合度 0..1：在 Xtreme 轨道上获得冲刺的能力 */
  gearGrip: number;
  visual: TipVisual;
}

export type PartSpec = BladeSpec | DiscSpec | TipSpec;
export type PartKind = PartSpec['kind'];

/** 一套组装方案（只存部件 id，便于存档和替换） */
export interface BeyLoadout {
  blade: string;
  disc: string;
  tip: string;
}
