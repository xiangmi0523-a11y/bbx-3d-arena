import type { BeyLoadout, BladeSpec, DiscSpec, PartKind, PartSpec, TipSpec } from './types';

/**
 * 部件目录（全部为原创设计）。
 * 新增部件只需在这里注册，组装界面、渲染、物理会自动支持。
 */

export const BLADES: Record<string, BladeSpec> = {
  'blaze-fang': {
    kind: 'blade',
    id: 'blaze-fang',
    name: '烈焰獠牙',
    code: 'BLAZE FANG',
    desc: '三片弯钩獠牙，金属刃口向外突出，擅长正面重击。',
    role: 'attack',
    spin: 'right',
    mass: 3.0,
    rimWeight: 0.5,
    radius: 0.52,
    height: 0.2,
    friction: 0.35,
    restitution: 0.55,
    attack: 0.9,
    defense: 0.25,
    visual: { style: 'fang', lobes: 3, primary: 0xe8302a, secondary: 0x1a1d24, metal: 0xd4d9e2, accent: 0xffb323 },
  },
  'tidal-bastion': {
    kind: 'blade',
    id: 'tidal-bastion',
    name: '潮汐堡垒',
    code: 'TIDAL BASTION',
    desc: '六段圆弧护甲加厚重金属外环，撞击时把力量分散开。',
    role: 'defense',
    spin: 'right',
    mass: 3.4,
    rimWeight: 0.55,
    radius: 0.5,
    height: 0.2,
    friction: 0.2,
    restitution: 0.4,
    attack: 0.35,
    defense: 0.7,
    visual: { style: 'bastion', lobes: 6, primary: 0x1f7cf0, secondary: 0xeef3fb, metal: 0xb7c2cf, accent: 0x39f0d8 },
  },
  'gale-crescent': {
    kind: 'blade',
    id: 'gale-crescent',
    name: '疾风新月',
    code: 'GALE CRESCENT',
    desc: '银色双层前掠爪刃配蓝色透明骨架，攻守平衡。',
    role: 'balance',
    spin: 'right',
    mass: 3.1,
    rimWeight: 0.55,
    radius: 0.53,
    height: 0.19,
    friction: 0.28,
    restitution: 0.5,
    attack: 0.65,
    defense: 0.45,
    visual: { style: 'gale', lobes: 10, primary: 0x1f5cff, secondary: 0x0c111d, metal: 0xdfe4ec, accent: 0x7fb4ff },
  },
  'titan-crown': {
    kind: 'blade',
    id: 'titan-crown',
    name: '泰坦王冠',
    code: 'TITAN CROWN',
    desc: '四瓣厚重王冠，外缘金属配重，转得最久。',
    role: 'stamina',
    spin: 'right',
    mass: 3.7,
    rimWeight: 0.78,
    radius: 0.49,
    height: 0.21,
    friction: 0.15,
    restitution: 0.35,
    attack: 0.3,
    defense: 0.6,
    visual: { style: 'crown', lobes: 4, primary: 0x1c1a22, secondary: 0xe6b84a, metal: 0xe9c66b, accent: 0xff5ad1 },
  },
};

export const DISCS: Record<string, DiscSpec> = {
  'tri-lock': {
    kind: 'disc',
    id: 'tri-lock',
    name: '三棱锁盘',
    code: 'TRI-LOCK',
    desc: '三个锁齿，轻量，适合攻击型。',
    mass: 0.9,
    rimWeight: 0.45,
    radius: 0.3,
    height: 0.13,
    burstResistance: 0.5,
    visual: { points: 3, sharpness: 0.6, color: 0x2a2e36, accent: 0xe8302a },
  },
  'hex-lock': {
    kind: 'disc',
    id: 'hex-lock',
    name: '六角锁盘',
    code: 'HEX-LOCK',
    desc: '六个锁齿，咬合牢固，不易松脱。',
    mass: 1.1,
    rimWeight: 0.5,
    radius: 0.32,
    height: 0.12,
    burstResistance: 0.75,
    visual: { points: 6, sharpness: 0.35, color: 0x2a2e36, accent: 0x1f7cf0 },
  },
  'quad-edge': {
    kind: 'disc',
    id: 'quad-edge',
    name: '四刃锁盘',
    code: 'QUAD-EDGE',
    desc: '四个尖锐锁齿，较高，让刀刃打得更高。',
    mass: 1.0,
    rimWeight: 0.55,
    radius: 0.31,
    height: 0.16,
    burstResistance: 0.55,
    visual: { points: 4, sharpness: 0.9, color: 0x30343d, accent: 0xffb323 },
  },
  'ring-guard': {
    kind: 'disc',
    id: 'ring-guard',
    name: '圆环护盘',
    code: 'RING GUARD',
    desc: '圆形整体护盘，重心低，最稳。',
    mass: 1.4,
    rimWeight: 0.8,
    radius: 0.34,
    height: 0.11,
    burstResistance: 0.85,
    visual: { points: 0, sharpness: 0, color: 0x3a3f4a, accent: 0x39f0d8 },
  },
};

export const TIPS: Record<string, TipSpec> = {
  'gear-flat': {
    kind: 'tip',
    id: 'gear-flat',
    name: '齿轮平轴',
    code: 'GEAR FLAT',
    desc: '平底加一圈齿轮，抓地并能咬住极限轨道冲刺。',
    mass: 0.35,
    contactRadius: 0.13,
    height: 0.24,
    friction: 0.45,
    spinDecay: 2.0,
    gearGrip: 1.0,
    drift: 0.16,
    visual: { shape: 'gear-flat', color: 0xe8302a, accent: 0xffb323 },
  },
  'dome-ball': {
    kind: 'tip',
    id: 'dome-ball',
    name: '圆顶球轴',
    code: 'DOME BALL',
    desc: '圆球接地，打滑回中，耐久与防守兼顾。',
    mass: 0.35,
    contactRadius: 0.09,
    height: 0.24,
    friction: 0.18,
    spinDecay: 1.2,
    gearGrip: 0.35,
    drift: 0.05,
    visual: { shape: 'ball', color: 0x1f7cf0, accent: 0x39f0d8 },
  },
  'needle-point': {
    kind: 'tip',
    id: 'needle-point',
    name: '针尖轴',
    code: 'NEEDLE',
    desc: '极细尖端，摩擦最小，几乎原地转到最后。',
    mass: 0.3,
    contactRadius: 0.045,
    height: 0.25,
    friction: 0.12,
    spinDecay: 0.85,
    gearGrip: 0.1,
    drift: 0.03,
    visual: { shape: 'point', color: 0xc9ced8, accent: 0xff5ad1 },
  },
  'rush-rubber': {
    kind: 'tip',
    id: 'rush-rubber',
    name: '橡胶突进轴',
    code: 'RUSH RUBBER',
    desc: '宽橡胶平底，抓地极强，移动最激烈但耗转快。',
    mass: 0.4,
    contactRadius: 0.15,
    height: 0.23,
    friction: 0.45,
    spinDecay: 2.0,
    gearGrip: 0.8,
    drift: 0.2,
    visual: { shape: 'rubber', color: 0x2fd27a, accent: 0x14161b },
  },
};

const TABLES: Record<PartKind, Record<string, PartSpec>> = {
  blade: BLADES,
  disc: DISCS,
  tip: TIPS,
};

export function getPart<K extends PartKind>(kind: K, id: string): Extract<PartSpec, { kind: K }> {
  const part = TABLES[kind][id];
  if (!part) throw new Error(`未知部件 ${kind}:${id}`);
  return part as Extract<PartSpec, { kind: K }>;
}

export function hasPart(kind: PartKind, id: string): boolean {
  return !!TABLES[kind][id];
}

export function listParts<K extends PartKind>(kind: K): Extract<PartSpec, { kind: K }>[] {
  return Object.values(TABLES[kind]) as Extract<PartSpec, { kind: K }>[];
}

/** 校验存档里的组装方案；不认识的部件回退到默认，不影响其他部件 */
export function sanitizeLoadout(l: Partial<BeyLoadout> | null | undefined, fallback: BeyLoadout): BeyLoadout {
  return {
    blade: l?.blade && hasPart('blade', l.blade) ? l.blade : fallback.blade,
    disc: l?.disc && hasPart('disc', l.disc) ? l.disc : fallback.disc,
    tip: l?.tip && hasPart('tip', l.tip) ? l.tip : fallback.tip,
  };
}

/** 默认的两台对战陀螺 */
export const PLAYER_LOADOUT: BeyLoadout = { blade: 'blaze-fang', disc: 'tri-lock', tip: 'gear-flat' };
export const RIVAL_LOADOUT: BeyLoadout = { blade: 'tidal-bastion', disc: 'hex-lock', tip: 'dome-ball' };
