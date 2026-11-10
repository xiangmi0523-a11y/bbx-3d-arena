import { mkdirSync, appendFileSync } from 'node:fs';
import { test } from 'vitest';
import { BEY_TUNING } from '../../src/game/beys/BeyPhysics';
import { SMASH_TUNING } from '../../src/game/battle/BattleSystem';
if (process.env.DIAG_TUNE) Object.assign(BEY_TUNING, JSON.parse(process.env.DIAG_TUNE));
if (process.env.DIAG_SMASH) Object.assign(SMASH_TUNING, JSON.parse(process.env.DIAG_SMASH));
import { PLAYER_LOADOUT, RIVAL_LOADOUT } from '../../src/game/beys/parts/catalog';
import type { BeyLoadout } from '../../src/game/beys/parts/types';
import { feelRun, type FeelRun } from '../feelSim';

/**
 * 战斗手感诊断（真实物理，无头）：速度感、撞击、贴身摩擦、原地空转（僵持）。
 *   npx vitest run --config vitest.diag.config.ts tests/diag/feel.diag.ts
 * 环境变量：DIAG_LABEL、DIAG_N（每组场数）、DIAG_TUNE / DIAG_SMASH（试调参数）
 */
const MATCHUPS: Record<string, { player: BeyLoadout; rival: BeyLoadout }> = {
  默认: { player: PLAYER_LOADOUT, rival: RIVAL_LOADOUT },
  平衡套装: { player: { blade: 'gale-crescent', ratchet: 'hex-lock', bit: 'dome-ball' }, rival: RIVAL_LOADOUT },
  攻击对防御: {
    player: { blade: 'blaze-fang', ratchet: 'tri-lock', bit: 'rush-rubber' },
    rival: { blade: 'tidal-bastion', ratchet: 'ring-guard', bit: 'dome-ball' },
  },
};

const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '-');
const avg = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;

test('battle feel', async () => {
  const N = Number(process.env.DIAG_N ?? 8);
  const label = process.env.DIAG_LABEL ?? 'now';
  mkdirSync('test-results/diag', { recursive: true });
  const lines = [
    `## ${label}`,
    '',
    '| 组合 | 平均时长 s | 平均速度 m/s | 快速移动占比 | 撞击 /10s | 中等以上 /10s | 贴身摩擦 /10s | 接触时间占比 | 最长连续接触 s | 僵持总时长 s | 最长僵持 s | 撞击 Δv 中位 | 结果 |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const [name, lo] of Object.entries(MATCHUPS)) {
    const runs: FeelRun[] = [];
    for (let i = 0; i < N; i++) runs.push(await feelRun(lo, 1000 + i));
    const dur = runs.reduce((s, r) => s + r.duration, 0);
    lines.push(
      `| ${name} | ${f(dur / N, 1)} | ${f(avg(runs.map((r) => r.meanSpeed)))} | ${f(avg(runs.map((r) => r.fastFrac)) * 100, 0)}% | ${f((runs.reduce((s, r) => s + r.hits, 0) / dur) * 10)} | ${f((runs.reduce((s, r) => s + r.strong, 0) / dur) * 10)} | ${f((runs.reduce((s, r) => s + r.grinds, 0) / dur) * 10)} | ${f(avg(runs.map((r) => r.contactFrac)) * 100, 0)}% | ${f(Math.max(...runs.map((r) => r.longestContact)), 1)} | ${f(runs.reduce((s, r) => s + r.stall, 0), 1)} | ${f(Math.max(...runs.map((r) => r.longestStall)), 1)} | ${f(avg(runs.map((r) => r.dvMedian).filter(Number.isFinite)))} | ${runs.map((r) => r.result).join(' ')} |`,
    );
  }
  lines.push('');
  appendFileSync('test-results/diag/feel.md', lines.join('\n') + '\n');
  console.log(lines.join('\n'));
});
