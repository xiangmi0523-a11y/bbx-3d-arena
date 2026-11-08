import { appendFileSync, mkdirSync } from 'node:fs';
import { test } from 'vitest';
import { BEY_TUNING } from '../../src/game/beys/BeyPhysics';
if (process.env.DIAG_TUNE) Object.assign(BEY_TUNING, JSON.parse(process.env.DIAG_TUNE));
import { simulateBattle } from '../sim';
import { diagnoseBattle } from './harness';

/** 复现 physics.test.ts 里两项统计测试的指标，便于调参：撞击频率、撞墙频率 */
test('test metrics', async () => {
  let hits = 0, strong = 0, time = 0;
  for (let i = 0; i < 6; i++) {
    const aim = ((i % 3) - 1) * 0.3;
    const r = await simulateBattle({ player: { power: 0.7 + (i % 3) * 0.15, aim, tilt: 0 }, rival: { power: 0.8, aim: -aim, tilt: 0 }, maxSeconds: 40 });
    hits += r.battle.hits; strong += r.battle.impacts.filter((e) => e.tier !== 'light').length; time += r.battle.time; r.dispose();
  }
  let walls = 0, wt = 0, near = 0;
  for (let i = 0; i < 6; i++) {
    const aim = ((i % 3) - 1) * 0.3;
    const r = await diagnoseBattle({ player: { power: 0.7 + (i % 3) * 0.15, aim, tilt: 0 }, rival: { power: 0.8, aim: -aim, tilt: 0 }, rivalLoadout: { blade: 'gale-crescent', disc: 'tri-lock', tip: 'rush-rubber' }, maxSeconds: 40 });
    walls += r.wallHits.player + r.wallHits.rival; wt += r.duration; near += r.nearWall.player + r.nearWall.rival;
  }
  mkdirSync('test-results/diag', { recursive: true });
  appendFileSync('test-results/diag/testmetrics.md', `${process.env.DIAG_LABEL ?? ''} hits/10s ${(hits / time * 10).toFixed(2)} strong/10s ${(strong / time * 10).toFixed(2)} dur ${(time / 6).toFixed(1)} | walls/10s ${(walls / wt * 10).toFixed(2)} near ${(near / 12).toFixed(3)}\n`);
});
