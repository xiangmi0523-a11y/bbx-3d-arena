import { ARENA_SCALE, floorHeight } from '../arena/arenaSpec';
import type { LaunchParams } from '../beys/BeyPhysics';
import type { AssembledBey } from '../beys/parts/assemble';
import type { LaunchCommand } from './PullStringGesture';

export type Side = 'player' | 'rival';

/** 发射点所在半径与离地高度 */
export const LAUNCH_RADIUS = 2.7 * ARENA_SCALE;
export const LAUNCH_HEIGHT = 0.75;

/** 玩家在 +Z 一侧（靠近镜头），对手在 -Z 一侧 */
export function sideAngle(side: Side): number {
  return side === 'player' ? Math.PI / 2 : -Math.PI / 2;
}

export function launchPoint(side: Side) {
  const a = sideAngle(side);
  const x = Math.cos(a) * LAUNCH_RADIUS;
  const z = Math.sin(a) * LAUNCH_RADIUS;
  return { x, y: floorHeight(LAUNCH_RADIUS) + LAUNCH_HEIGHT, z };
}

/**
 * 发射方向：aim=0 时斜向切入场地（顺着右旋陀螺的轨道方向，便于骑上极限轨道），
 * aim=±1 时左右偏转 55°。返回水平单位向量。
 */
export function launchDirection(side: Side, aim: number) {
  const a = sideAngle(side);
  // 指向中心
  const cx = -Math.cos(a);
  const cz = -Math.sin(a);
  const base = side === 'player' ? -0.35 : 0.35; // 默认略微偏向，避免正面对撞
  const yaw = base + aim * 0.95;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return { x: cx * c - cz * s, y: 0, z: cx * s + cz * c };
}

/** 把发射指令换算成物理初始状态 */
export function computeLaunch(spec: AssembledBey, side: Side, cmd: LaunchCommand): LaunchParams {
  const p = Math.max(0, Math.min(1, cmd.power));
  const dir = launchDirection(side, cmd.aim);
  const speed = 2.2 + 6.3 * p;
  const tilt = cmd.tilt * 0.35;
  return {
    position: launchPoint(side),
    velocity: { x: dir.x * speed, y: -1.5, z: dir.z * speed },
    spin: spec.maxSpin * (0.4 + 0.6 * p),
    tilt,
    // 倾斜轴 = 发射方向的垂直方向
    tiltAxis: { x: -dir.z, y: 0, z: dir.x },
  };
}

/** 电脑对手的发射指令：力度 0.55~0.95，方向随机 */
export function rivalCommand(rand: () => number = Math.random): LaunchCommand {
  return { power: 0.55 + rand() * 0.4, aim: (rand() - 0.5) * 1.2, tilt: 0 };
}

/**
 * 发射力度三档（v2.0 §6.1 / §10.3：轻 / 中 / 重 = 0.65 / 0.8 / 0.95，与平衡验证用的诊断矩阵 POW 档一致）。
 * 拉绳手势照常给出连续力度（仪式感：拉得越长、松手越快越强），松手时归到三档之一，
 * 保证游戏里出现的发射状态都是验证过的那三种。
 */
export const POWER_TIERS = [
  { key: 'light', label: '轻', power: 0.65 },
  { key: 'medium', label: '中', power: 0.8 },
  { key: 'heavy', label: '重', power: 0.95 },
] as const;
export type PowerTier = (typeof POWER_TIERS)[number];

/** 手势力度 → 档位：< 0.55 轻，< 0.8 中，其余重（满拉不甩 = 0.65 → 中；满拉快甩 → 重） */
export function powerTier(raw: number): PowerTier {
  return raw < 0.55 ? POWER_TIERS[0] : raw < 0.8 ? POWER_TIERS[1] : POWER_TIERS[2];
}

/**
 * 电脑对手的发射（游戏内用；回归测试仍用 rivalCommand 保持固定种子场景不变）。
 * 难度只改“发射决策”的分布，不改物理：新手多用轻 / 中档、方向随意；高手多用重档、方向更准。
 */
export function aiLaunchCommand(rand: () => number, level: 'rookie' | 'pro' | 'master'): LaunchCommand {
  const w = level === 'rookie' ? [0.5, 0.4, 0.1] : level === 'master' ? [0.05, 0.35, 0.6] : [1 / 3, 1 / 3, 1 / 3];
  const r = rand();
  const tier = r < w[0] ? POWER_TIERS[0] : r < w[0] + w[1] ? POWER_TIERS[1] : POWER_TIERS[2];
  const spread = level === 'rookie' ? 1.4 : level === 'master' ? 0.6 : 1.2;
  return { power: tier.power, aim: (rand() - 0.5) * spread, tilt: 0 };
}
