import type { BeyLoadout, BeyRole, BitSpec, BladeSpec, PartKind, PartSpec, RatchetSpec } from './types';

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

export const RATCHETS: Record<string, RatchetSpec> = {
  'tri-lock': {
    kind: 'ratchet',
    id: 'tri-lock',
    name: '三齿棘轮',
    code: 'TRI-LOCK',
    desc: '三个锁齿，轻量，适合攻击型。',
    mass: 0.9,
    rimWeight: 0.45,
    radius: 0.3,
    height: 0.13,
    lock: 0.5,
    teeth: 3,
    visual: { sharpness: 0.6, color: 0x2a2e36, accent: 0xe8302a },
  },
  'hex-lock': {
    kind: 'ratchet',
    id: 'hex-lock',
    name: '六齿棘轮',
    code: 'HEX-LOCK',
    desc: '六个锁齿，咬合牢固，不易松脱。',
    mass: 1.1,
    rimWeight: 0.5,
    radius: 0.32,
    height: 0.12,
    lock: 0.75,
    teeth: 6,
    visual: { style: 'ratchet', sharpness: 0.35, color: 0x0b1c4a, accent: 0x1f5cff },
  },
  'quad-edge': {
    kind: 'ratchet',
    id: 'quad-edge',
    name: '四齿棘轮',
    code: 'QUAD-EDGE',
    desc: '四个尖锐锁齿，较高，让刀刃打得更高。',
    mass: 1.0,
    rimWeight: 0.55,
    radius: 0.31,
    height: 0.16,
    lock: 0.55,
    teeth: 4,
    visual: { sharpness: 0.9, color: 0x30343d, accent: 0xffb323 },
  },
  'ring-guard': {
    kind: 'ratchet',
    id: 'ring-guard',
    name: '圆环护轮',
    code: 'RING GUARD',
    desc: '圆形整体护盘，重心低，最稳。',
    mass: 1.4,
    rimWeight: 0.8,
    radius: 0.34,
    height: 0.11,
    lock: 0.85,
    teeth: 0,
    visual: { sharpness: 0, color: 0x3a3f4a, accent: 0x39f0d8 },
  },
};

export const BITS: Record<string, BitSpec> = {
  'gear-flat': {
    kind: 'bit',
    role: 'balance',
    id: 'gear-flat',
    name: '平齿轴',
    code: 'GEAR FLAT',
    desc: '平底加一圈齿轮，抓地，齿轮能咬住轨道冲刺。',
    mass: 0.35,
    contactRadius: 0.13,
    height: 0.24,
    friction: 0.45,
    spinDecay: 2.0,
    gearGrip: 1.0,
    drift: 0.16,
    gear: true,
    burstGuard: 0.85,
    visual: { shape: 'gear-flat', color: 0xe8302a, accent: 0xffb323 },
  },
  'dome-ball': {
    kind: 'bit',
    role: 'stamina',
    id: 'dome-ball',
    name: '圆球轴',
    code: 'DOME BALL',
    desc: '圆球接地，打滑回中，耐久与防守兼顾。',
    mass: 0.35,
    contactRadius: 0.09,
    height: 0.24,
    friction: 0.18,
    spinDecay: 1.2,
    gearGrip: 0.35,
    drift: 0.05,
    gear: false,
    burstGuard: 0.5,
    visual: { shape: 'ball', color: 0x1f7cf0, accent: 0x39f0d8 },
  },
  'needle-point': {
    kind: 'bit',
    role: 'defense',
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
    gear: false,
    burstGuard: 0.35,
    visual: { shape: 'point', color: 0xc9ced8, accent: 0xff5ad1 },
  },
  'rush-rubber': {
    kind: 'bit',
    role: 'attack',
    id: 'rush-rubber',
    name: '橡胶轴',
    code: 'RUSH RUBBER',
    desc: '宽橡胶平底，抓地极强，移动最激烈但耗转快。',
    mass: 0.4,
    contactRadius: 0.15,
    height: 0.23,
    friction: 0.45,
    spinDecay: 2.0,
    gearGrip: 0.8,
    drift: 0.2,
    gear: false,
    burstGuard: 0.9,
    visual: { shape: 'rubber', color: 0x2fd27a, accent: 0x14161b },
  },
};

const TABLES: Record<PartKind, Record<string, PartSpec>> = {
  blade: BLADES,
  ratchet: RATCHETS,
  bit: BITS,
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
    ratchet: l?.ratchet && hasPart('ratchet', l.ratchet) ? l.ratchet : fallback.ratchet,
    bit: l?.bit && hasPart('bit', l.bit) ? l.bit : fallback.bit,
  };
}

export type SignatureKey = 'lieren' | 'pandun' | 'senheng' | 'ziyao';

/** 签名构筑：四类陀螺的推荐组合（不是固定陀螺，零件可自由混搭）。v2.0 §3.2：类型由 Bit 决定 */
export interface SignatureBuild {
  key: SignatureKey;
  name: string;
  role: BeyRole;
  /** 主色（界面卡片 / 结算） */
  color: number;
  loadout: BeyLoadout;
}

/** v2.0 签名构筑（R2：紫曜改圆球轴、磐盾改针尖轴，与官方分类对齐） */
export const SIGNATURES: Record<SignatureKey, SignatureBuild> = {
  lieren: { key: 'lieren', name: '烈刃', role: 'attack', color: 0xe8302a, loadout: { blade: 'blaze-fang', ratchet: 'quad-edge', bit: 'rush-rubber' } },
  pandun: { key: 'pandun', name: '磐盾', role: 'defense', color: 0x1f7cf0, loadout: { blade: 'tidal-bastion', ratchet: 'ring-guard', bit: 'needle-point' } },
  senheng: { key: 'senheng', name: '森衡', role: 'balance', color: 0x2fae5f, loadout: { blade: 'gale-crescent', ratchet: 'hex-lock', bit: 'gear-flat' } },
  ziyao: { key: 'ziyao', name: '紫曜', role: 'stamina', color: 0x8b5cf6, loadout: { blade: 'titan-crown', ratchet: 'tri-lock', bit: 'dome-ball' } },
};

export const SIGNATURE_LIST: SignatureBuild[] = [SIGNATURES.lieren, SIGNATURES.pandun, SIGNATURES.senheng, SIGNATURES.ziyao];

/** 默认的两台对战陀螺（v1 默认对局，签名构筑换位见 SIGNATURES） */
export const PLAYER_LOADOUT: BeyLoadout = { blade: 'blaze-fang', ratchet: 'tri-lock', bit: 'gear-flat' };
export const RIVAL_LOADOUT: BeyLoadout = { blade: 'tidal-bastion', ratchet: 'hex-lock', bit: 'dome-ball' };
