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

export interface DiscVisual {
  /** 外观样式：'ratchet' = P2.3 阶段 2 的锁齿式写实模型；省略 = 旧的简化模型 */
  style?: 'ratchet';
  /** 固锁盘凸起数（0 = 圆盘） */
  points: number;
  /** 凸起的尖锐程度 0..1 */
  sharpness: number;
  color: number;
  accent: number;
}

export interface DiscSpec extends PartBase {
  kind: 'disc';
  radius: number;
  height: number;
  /** 抗爆裂值（P1 预留，P2 爆裂判定使用） */
  burstResistance: number;
  /** 重量分布（同 Blade.rimWeight） */
  rimWeight: number;
  visual: DiscVisual;
}

export type TipShape = 'gear-flat' | 'ball' | 'point' | 'rubber';

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
  /** 自然倾角（弧度）：越大越容易走出大范围的花瓣轨迹 */
  drift: number;
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
