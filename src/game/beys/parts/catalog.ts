import type { BeyLoadout, BladeSpec, DiscSpec, PartKind, PartSpec, TipSpec } from './types';

/**
 * 部件目录（全部为原创设计）。
 * 新增部件只需在这里注册，组装、渲染、物理会自动支持。
 */

export const BLADES: Record<string, BladeSpec> = {
  'blaze-fang': {
    kind: 'blade',
    id: 'blaze-fang',
    name: '烈焰獠牙',
    code: 'BLAZE FANG',
    role: 'attack',
    spin: 'right',
    mass: 3.0,
    radius: 0.52,
    height: 0.2,
    friction: 0.35,
    restitution: 0.55,
    attack: 0.9,
    defense: 0.25,
    visual: {
      style: 'fang',
      lobes: 3,
      primary: 0xe8302a,
      secondary: 0x1a1d24,
      metal: 0xc9ced8,
      accent: 0xffb323,
    },
  },
  'tidal-bastion': {
    kind: 'blade',
    id: 'tidal-bastion',
    name: '潮汐堡垒',
    code: 'TIDAL BASTION',
    role: 'defense',
    spin: 'right',
    mass: 3.4,
    radius: 0.5,
    height: 0.2,
    friction: 0.2,
    restitution: 0.4,
    attack: 0.35,
    defense: 0.7,
    visual: {
      style: 'bastion',
      lobes: 6,
      primary: 0x1f7cf0,
      secondary: 0xeef3fb,
      metal: 0xb7c2cf,
      accent: 0x39f0d8,
    },
  },
};

export const DISCS: Record<string, DiscSpec> = {
  'tri-lock': {
    kind: 'disc',
    id: 'tri-lock',
    name: '三棱锁盘',
    code: 'TRI-LOCK',
    mass: 0.9,
    radius: 0.3,
    height: 0.13,
    burstResistance: 0.5,
    visual: { points: 3, color: 0x2a2e36, accent: 0xe8302a },
  },
  'hex-lock': {
    kind: 'disc',
    id: 'hex-lock',
    name: '六角锁盘',
    code: 'HEX-LOCK',
    mass: 1.1,
    radius: 0.32,
    height: 0.12,
    burstResistance: 0.75,
    visual: { points: 6, color: 0x2a2e36, accent: 0x1f7cf0 },
  },
};

export const TIPS: Record<string, TipSpec> = {
  'gear-flat': {
    kind: 'tip',
    id: 'gear-flat',
    name: '齿轮平轴',
    code: 'GEAR FLAT',
    mass: 0.35,
    contactRadius: 0.13,
    height: 0.24,
    friction: 0.45,
    spinDecay: 2.0,
    gearGrip: 1.0,
    visual: { shape: 'gear-flat', color: 0xe8302a, accent: 0xffb323 },
  },
  'dome-ball': {
    kind: 'tip',
    id: 'dome-ball',
    name: '圆顶球轴',
    code: 'DOME BALL',
    mass: 0.35,
    contactRadius: 0.09,
    height: 0.24,
    friction: 0.18,
    spinDecay: 1.2,
    gearGrip: 0.35,
    visual: { shape: 'ball', color: 0x1f7cf0, accent: 0x39f0d8 },
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

export function listParts<K extends PartKind>(kind: K): Extract<PartSpec, { kind: K }>[] {
  return Object.values(TABLES[kind]) as Extract<PartSpec, { kind: K }>[];
}

/** P1 默认的两台对战陀螺 */
export const PLAYER_LOADOUT: BeyLoadout = { blade: 'blaze-fang', disc: 'tri-lock', tip: 'gear-flat' };
export const RIVAL_LOADOUT: BeyLoadout = { blade: 'tidal-bastion', disc: 'hex-lock', tip: 'dome-ball' };
