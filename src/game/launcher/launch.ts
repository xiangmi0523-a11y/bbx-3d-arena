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
