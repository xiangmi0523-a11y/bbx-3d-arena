import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'vitest';
import { BEY_TUNING } from '../../src/game/beys/BeyPhysics';
import { SMASH_TUNING } from '../../src/game/battle/BattleSystem';
import { ARENA } from '../../src/game/arena/arenaSpec';
if (process.env.DIAG_ARENA) Object.assign(ARENA, JSON.parse(process.env.DIAG_ARENA));
import { getPart } from '../../src/game/beys/parts/catalog';
if (process.env.DIAG_PARTS) {
  for (const [key, patch] of Object.entries(JSON.parse(process.env.DIAG_PARTS) as Record<string, object>)) {
    const [kind, id] = key.split(':');
    Object.assign(getPart(kind as 'blade', id), patch);
  }
}
if (process.env.DIAG_TUNE) Object.assign(BEY_TUNING, JSON.parse(process.env.DIAG_TUNE));
if (process.env.DIAG_SMASH) Object.assign(SMASH_TUNING, JSON.parse(process.env.DIAG_SMASH));
import { diagnoseBattle, type DiagResult } from './harness';
import { simulateBattle } from '../sim';

/** 三种战术定位的代表组合（只用现有零件） */
export const ARCHETYPES = {
  攻击: { blade: 'blaze-fang', disc: 'tri-lock', tip: 'rush-rubber' },
  防御: { blade: 'tidal-bastion', disc: 'ring-guard', tip: 'dome-ball' },
  耐力: { blade: 'titan-crown', disc: 'hex-lock', tip: 'needle-point' },
} as const;
type Arch = keyof typeof ARCHETYPES;

const OUT = process.env.DIAG_OUT ?? 'test-results/diag/types.md';
const LABEL = process.env.DIAG_LABEL ?? 'current';
const N = Number(process.env.DIAG_N ?? 8);
const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '-');
const avg = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);

test('type matrix', async () => {
  mkdirSync('test-results/diag', { recursive: true });
  const lines = [`## ${LABEL}`, ''];
  // 1) 单独旋转时长（同一发射力度，场上只有自己：用对手远离的方式近似 = 正常对战里不计碰撞）
  lines.push('| 组合 | 质量 | 单独旋转到停转（秒） |', '|---|---|---|');
  for (const [name, lo] of Object.entries(ARCHETYPES)) {
    const r = await simulateBattle({
      player: { power: 0.85, aim: 0, tilt: 0 },
      rival: { power: 0.85, aim: 0, tilt: 0 },
      playerLoadout: lo,
      rivalLoadout: lo,
      maxSeconds: 0.01,
    });
    // 把对手移出场地外的台面上空并冻结，测自己单独能转多久
    const b = r.battle.beys.rival!;
    b.body.setTranslation({ x: 40, y: 50, z: 40 }, true);
    b.body.setGravityScale(0, true);
    b.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    let t = 0;
    const a = r.battle.beys.player!;
    while (t < 200 && a.spin > 3 && a.tilt < 1.2) {
      r.step();
      b.body.setTranslation({ x: 40, y: 50, z: 40 }, true);
      b.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      t += 1 / 120;
    }
    lines.push(`| ${name} | ${f(a.body.mass())} | ${f(t, 1)} |`);
    r.dispose();
  }
  lines.push('');

  // 2) 对战矩阵
  lines.push(
    '| 对局（A vs B） | A 胜 / B 胜 / 平 | 终结方式 | 有效撞击 /10s | 中段中等以上 /10s | 撞墙 /10s（A / B） | 贴边 A / B | 平均离中心 A / B | 中等以上撞击中受到的 Δv A / B | 转速半衰 A / B（秒） |',
    '|---|---|---|---|---|---|---|---|---|---|',
  );
  const names = Object.keys(ARCHETYPES) as Arch[];
  const all: Record<string, DiagResult[]> = {};
  for (let i = 0; i < names.length; i++) {
    for (let j = i; j < names.length; j++) {
      const A = names[i];
      const B = names[j];
      const runs: DiagResult[] = [];
      for (let k = 0; k < N; k++) {
        const aim = ((k % 3) - 1) * 0.3;
        // 交换发射位，消除场地左右差异
        const swap = k % 2 === 1;
        const res = await diagnoseBattle({
          player: { power: 0.75 + (k % 3) * 0.1, aim, tilt: 0 },
          rival: { power: 0.75 + ((k + 1) % 3) * 0.1, aim: -aim, tilt: 0 },
          playerLoadout: swap ? ARCHETYPES[B] : ARCHETYPES[A],
          rivalLoadout: swap ? ARCHETYPES[A] : ARCHETYPES[B],
          maxSeconds: 60,
        });
        if (swap) {
          // 统一成 A 在 player 一侧
          const sw = <T,>(o: { player: T; rival: T }) => ({ player: o.rival, rival: o.player });
          res.wallHits = sw(res.wallHits);
          res.nearWall = sw(res.nearWall);
          res.meanR = sw(res.meanR);
          res.spinHalf = sw(res.spinHalf);
          res.dvTaken = sw(res.dvTaken);
          res.winner = res.winner === 'player' ? 'rival' : res.winner === 'rival' ? 'player' : 'none';
        }
        runs.push(res);
      }
      all[`${A}-${B}`] = runs;
      const dur = runs.reduce((s, r) => s + r.duration, 0);
      const eps = runs.flatMap((r) => r.episodes);
      const fin: Record<string, number> = {};
      for (const r of runs) {
        const k2 = r.result.split(' ')[1] ?? 'timeout';
        fin[k2] = (fin[k2] ?? 0) + 1;
      }
      lines.push(
        `| ${A} vs ${B} | ${runs.filter((r) => r.winner === 'player').length} / ${runs.filter((r) => r.winner === 'rival').length} / ${runs.filter((r) => r.winner === 'none').length} | ${Object.entries(fin).map(([k2, v]) => `${k2}×${v}`).join(' ')} | ${f((eps.filter((e) => e.tier).length / dur) * 10)} | ${f((eps.filter((e) => e.t > 1.5 && (e.tier === 'medium' || e.tier === 'heavy')).length / dur) * 10)} | ${f((runs.reduce((s, r) => s + r.wallHits.player, 0) / dur) * 10)} / ${f((runs.reduce((s, r) => s + r.wallHits.rival, 0) / dur) * 10)} | ${f(avg(runs.map((r) => r.nearWall.player)) * 100, 0)}% / ${f(avg(runs.map((r) => r.nearWall.rival)) * 100, 0)}% | ${f(avg(runs.map((r) => r.meanR.player)))} / ${f(avg(runs.map((r) => r.meanR.rival)))} | ${f(avg(runs.flatMap((r) => r.dvTaken.player)))} / ${f(avg(runs.flatMap((r) => r.dvTaken.rival)))} | ${f(avg(runs.map((r) => r.spinHalf.player)), 1)} / ${f(avg(runs.map((r) => r.spinHalf.rival)), 1)} |`,
      );
    }
  }
  const allRuns = Object.values(all).flat();
  const dur = allRuns.reduce((s, r) => s + r.duration, 0);
  lines.push(
    '',
    `- 全部 ${allRuns.length} 场：撞墙 ${f((allRuns.reduce((s, r) => s + r.wallHits.player + r.wallHits.rival, 0) / dur) * 10)} 次 / 10 秒（两台合计），撞墙径向速度均值 ${f(avg(allRuns.flatMap((r) => r.wallHitSpeeds)))} m/s；贴边时间 ${f(avg(allRuns.flatMap((r) => [r.nearWall.player, r.nearWall.rival])) * 100, 0)}%；有效撞击 ${f((allRuns.flatMap((r) => r.episodes).filter((e) => e.tier).length / dur) * 10)} / 10 秒；平均时长 ${f(dur / allRuns.length, 1)} 秒`,
    '',
  );
  appendFileSync(OUT, lines.join('\n') + '\n');
  writeFileSync(OUT.replace('.md', `-${LABEL}.json`), JSON.stringify(Object.fromEntries(Object.entries(all).map(([k, v]) => [k, v.map((r) => ({ ...r, episodes: r.episodes.length }))])), null, 1));
});
