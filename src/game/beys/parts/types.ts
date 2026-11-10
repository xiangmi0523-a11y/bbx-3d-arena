/**
 * 陀螺部件数据定义（产品总方案 v2.0 §4.2 数据契约）。
 *
 * 一个陀螺 = Blade（上层战斗环）+ Ratchet（中层配重环 / 锁扣）+ Bit（底部轴尖）。
 * 每个部件同时包含两类彼此独立的数据：
 *  - visual：只给渲染层（Three.js）使用的外观参数；
 *  - 物理与规则参数（尺寸、质量、摩擦、锁扣等）：只给物理层（Rapier）与战斗规则使用。
 * 渲染层和物理层分别读取自己需要的字段，互不依赖，
 * 后续更换外观模型（例如导入 glTF）不会影响碰撞体，反之亦然。
 *
 * v2.0 更名：Disc → Ratchet、Tip → Bit（部件 id 不变，存档 v1 → v2 只迁移槽位名）。
 */

export type SpinDirection = 'right' | 'left';
/** 陀螺类型。类型由 Bit 决定（官方规则；v2.0 §3.1 原则 2） */
export type BeyRole = 'attack' | 'defense' | 'stamina' | 'balance';

/** 所有部件共享的基础字段 */
export interface PartBase {
  id: string;
  name: string;
  /** 一句话简介（组装界面显示） */
  desc: string;
  /** 英文代号，用于 UI 和存档 */
  code: string;
  /** 质量（游戏单位） */
  mass: number;
}

/** gale = P2.3 按设计参考图重制的银蓝平衡型（疾风新月） */
export type BladeStyle = 'fang' | 'bastion' | 'crescent' | 'crown' | 'gale';

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
  /** 刀刃的设计倾向（签名构筑的类型；陀螺的类型由 Bit 决定，见 BitSpec.role） */
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
  /**
   * 重量分布：转动惯量 = 质量 × 半径² × rimWeight。
   * 0.5 = 均匀圆盘；越大重量越集中在外缘（耐力型的配重外圈），同样质量下更能维持旋转。
   */
  rimWeight: number;
  visual: BladeVisual;
}

export interface RatchetVisual {
  /** 外观样式：'ratchet' = P2.3 阶段 2 的锁齿式写实模型；省略 = 旧的简化模型 */
  style?: 'ratchet';
  /** 凸起的尖锐程度 0..1 */
  sharpness: number;
  color: number;
  accent: number;
}

export interface RatchetSpec extends PartBase {
  kind: 'ratchet';
  radius: number;
  height: number;
  /**
   * 锁扣强度 0..1（v2.0 新增的机制字段，数值继承原 burstResistance）：爆裂应力的分母之一，
   * Δstress = k_burst × 冲量 / (lock × Bit.burstGuard)（见 battle/burst.ts）。
   */
  lock: number;
  /** 锁齿数（0 = 连续圆环，最牢）：lock 的视觉表达 */
  teeth: number;
  /** 重量分布（同 Blade.rimWeight） */
  rimWeight: number;
  visual: RatchetVisual;
}

export type BitShape = 'gear-flat' | 'ball' | 'point' | 'rubber';

export interface BitVisual {
  shape: BitShape;
  color: number;
  accent: number;
}

export interface BitSpec extends PartBase {
  kind: 'bit';
  /** 陀螺类型由 Bit 决定：橡胶 = 攻击、针尖 = 防守、平齿 = 平衡、圆球 = 耐力（v2.0 §3.2） */
  role: BeyRole;
  /** 与地面接触的球半径（越大越“抓地”、移动越激烈） */
  contactRadius: number;
  /** 轴尖总高度 */
  height: number;
  /** 与场地的摩擦系数 */
  friction: number;
  /** 恒定转速衰减（rad/s²） */
  spinDecay: number;
  /** 牵引咬合度 0..1：把倾斜转化为移动的能力 */
  gearGrip: number;
  /** 自然倾角（弧度）：越大越容易走出大范围的花瓣轨迹 */
  drift: number;
  /** 是否带齿轮：只有带齿轮的 Bit 能在轨道上冲刺（v2.0 R8，真实机制是齿轮啮合） */
  gear: boolean;
  /** 抗爆护轴 0..1（v2.0 新增：Bit 轴粗细的抽象，初值待爆裂标定实验校准） */
  burstGuard: number;
  visual: BitVisual;
}

export type PartSpec = BladeSpec | RatchetSpec | BitSpec;
export type PartKind = PartSpec['kind'];

/** 一套组装方案（只存部件 id，便于存档和替换） */
export interface BeyLoadout {
  blade: string;
  ratchet: string;
  bit: string;
}

/** 部件槽位（从上到下）与界面名称 */
export const PART_KINDS: readonly PartKind[] = ['blade', 'ratchet', 'bit'];
