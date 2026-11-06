/**
 * 自主运动固定种子测试矩阵（基线与新版本共用，逐场对比）。
 * 每个场景的种子、发射指令、初始进动相位都写死，两版跑的是完全相同的输入。
 */
import type { BeyLoadout } from '../../src/game/beys/parts/types';
import type { MotionScenario } from './motionSim';

export const ATK: BeyLoadout = { blade: 'blaze-fang', disc: 'tri-lock', tip: 'rush-rubber' };
export const DEF: BeyLoadout = { blade: 'tidal-bastion', disc: 'ring-guard', tip: 'dome-ball' };
export const STA: BeyLoadout = { blade: 'titan-crown', disc: 'hex-lock', tip: 'needle-point' };
export const BAL: BeyLoadout = { blade: 'gale-crescent', disc: 'hex-lock', tip: 'dome-ball' };
/** 游戏默认组合 */
export const DEF_PLAYER: BeyLoadout = { blade: 'blaze-fang', disc: 'tri-lock', tip: 'gear-flat' };
export const DEF_RIVAL: BeyLoadout = { blade: 'tidal-bastion', disc: 'hex-lock', tip: 'dome-ball' };

export interface Group {
  key: string;
  title: string;
  scenarios: MotionScenario[];
}

const POW = [0.65, 0.8, 0.95];
const AIM = [0, 0.35, -0.35, 0.7];

/** 每个对阵 16 场（MOTION_N 可改）：力度 / 方向轮换，种子固定 */
function matchup(key: string, player: BeyLoadout, rival: BeyLoadout, seedBase: number, n = Number((globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.MOTION_N ?? 16), maxSeconds = 60): MotionScenario[] {
  const out: MotionScenario[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      name: `${key}#${i}`,
      player,
      rival,
      pCmd: { power: POW[i % 3], aim: AIM[i % 4], tilt: 0 },
      rCmd: { power: POW[(i + 1) % 3], aim: -AIM[(i + 2) % 4], tilt: 0 },
      seed: seedBase + i,
      maxSeconds,
    });
  }
  return out;
}

export function groups(): Group[] {
  const g: Group[] = [
    { key: 'AvD', title: '1. 攻击 对 防御', scenarios: matchup('AvD', ATK, DEF, 100) },
    { key: 'DvA', title: '2. 防御 对 攻击', scenarios: matchup('DvA', DEF, ATK, 200) },
    { key: 'SvA', title: '3. 耐力 对 攻击', scenarios: matchup('SvA', STA, ATK, 300) },
    { key: 'BvB', title: '4. 平衡 对 平衡', scenarios: matchup('BvB', BAL, BAL, 400) },
    { key: 'AvA', title: '5a. 相同配置（攻击 对 攻击）', scenarios: matchup('AvA', ATK, ATK, 500) },
    { key: 'DFLT', title: '5b. 默认组合（游戏默认玩家 对 默认对手）', scenarios: matchup('DFLT', DEF_PLAYER, DEF_RIVAL, 600) },
  ];
  // 10a. 撞墙：沿用 physics.test「扩大场地后极少撞墙」的对阵（默认玩家 对 平衡刀刃 + 橡胶轴心），固定种子
  g.push({
    key: 'WALL',
    title: '10a. 撞墙频率（默认玩家 对 疾风新月 + 三棱 + 橡胶，固定种子）',
    scenarios: Array.from({ length: 12 }, (_, i) => {
      const aim = ((i % 3) - 1) * 0.3;
      return {
        name: `WALL#${i}`,
        player: DEF_PLAYER,
        rival: { blade: 'gale-crescent', disc: 'tri-lock', tip: 'rush-rubber' },
        pCmd: { power: 0.7 + (i % 3) * 0.15, aim, tilt: 0 },
        rCmd: { power: 0.8, aim: -aim, tilt: 0 },
        seed: 1100 + i,
        maxSeconds: 40,
      };
    }),
  });
  // 6. 不同初始进攻角度（默认组合，aim −1 … 1）
  g.push({
    key: 'AIM',
    title: '6. 不同初始进攻角度（默认组合）',
    scenarios: [-1, -0.5, 0, 0.5, 1].flatMap((aim, i) =>
      [0, 1].map((k) => ({
        name: `AIM ${aim}#${k}`,
        player: DEF_PLAYER,
        rival: DEF_RIVAL,
        pCmd: { power: 0.8, aim, tilt: 0 },
        rCmd: { power: 0.8, aim: k ? -aim : 0, tilt: 0 },
        seed: 700 + i * 2 + k,
        maxSeconds: 60,
      })),
    ),
  });
  // 7. 不同初始进动相位（攻击 对 防御，同一发射指令，只改相位）
  g.push({
    key: 'PHASE',
    title: '7. 不同初始进动相位（攻击 对 防御，发射指令相同）',
    scenarios: [0, 1, 2, 3, 4, 5].map((k) => ({
      name: `PHASE ${k}`,
      player: ATK,
      rival: DEF,
      pCmd: { power: 0.8, aim: 0, tilt: 0 },
      rCmd: { power: 0.8, aim: 0, tilt: 0 },
      seed: 800,
      phase: [(k * Math.PI) / 3, ((k + 2) * Math.PI) / 3] as [number, number],
      maxSeconds: 60,
    })),
  });
  // 8. 不同发射力度（平衡 对 默认对手）
  g.push({
    key: 'POWER',
    title: '8. 不同发射力度（平衡 对 默认对手）',
    scenarios: [0.3, 0.5, 0.7, 0.85, 1].flatMap((power, i) =>
      [0, 1].map((k) => ({
        name: `POWER ${power}#${k}`,
        player: BAL,
        rival: DEF_RIVAL,
        pCmd: { power, aim: k ? 0.3 : 0, tilt: 0 },
        rCmd: { power: 0.75, aim: 0, tilt: 0 },
        seed: 900 + i * 2 + k,
        maxSeconds: 60,
      })),
    ),
  });
  // 10. 竞技场边缘与长时间战斗：朝墙方向发射、120 秒上限
  g.push({
    key: 'LONG',
    title: '10. 竞技场边缘与长时间战斗（朝外侧发射，最长 120 秒）',
    scenarios: [
      ...[1, -1].map((aim, k) => ({
        name: `EDGE A/D aim ${aim}`,
        player: ATK,
        rival: DEF,
        pCmd: { power: 1, aim, tilt: 0 },
        rCmd: { power: 1, aim: -aim, tilt: 0 },
        seed: 1000 + k,
        maxSeconds: 120,
      })),
      ...[0, 1].map((k) => ({
        name: `LONG S/S#${k}`,
        player: STA,
        rival: { ...STA, blade: 'tidal-bastion' },
        pCmd: { power: 0.9, aim: k * 0.5, tilt: 0 },
        rCmd: { power: 0.9, aim: 0, tilt: 0 },
        seed: 1010 + k,
        maxSeconds: 120,
      })),
      ...[0, 1].map((k) => ({
        name: `LONG A/A#${k}`,
        player: ATK,
        rival: ATK,
        pCmd: { power: 1, aim: 0.9, tilt: 0 },
        rCmd: { power: 1, aim: 0.9, tilt: 0 },
        seed: 1020 + k,
        maxSeconds: 120,
      })),
    ],
  });
  return g;
}

/** 轨迹图用的代表场次（第 9 项“碰撞后的轨迹变化”看接触前后方向变化指标 + 轨迹图） */
export const TRACE_PICKS = ['AvD#1', 'BvB#0', 'SvA#2', 'DFLT#3', 'DFLT#4', 'POWER 0.85#0', 'AvA#2', 'DvA#1'];
