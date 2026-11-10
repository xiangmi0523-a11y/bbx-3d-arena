import { writeFileSync, mkdirSync } from 'node:fs';
import { test } from 'vitest';
import { diagnoseBattle } from './harness';
import { simulateBattle } from '../sim';
import { seeded } from '../feelSim';
import { INTENT_TUNING } from '../../src/game/beys/motionIntent';
if (process.env.DIAG_INTENT) Object.assign(INTENT_TUNING, JSON.parse(process.env.DIAG_INTENT));

/**
 * physics.test 里两条未固定种子的测试（「扩大场地后极少撞墙」「轻 / 中 / 猛三档都会出现」），
 * 用 30 组固定种子复现同样的场景，统计通过率与平均值，用于基线与新版本对比。
 *   WALL_OUT=xxx.json npx vitest run --config vitest.diag.config.ts tests/diag/wallrate.diag.ts
 */
test('wall / tiers rate', async () => {
  const orig = Math.random;
  const wall: number[] = [];
  const near: number[] = [];
  const tierOk: boolean[] = [];
  const hitRate: number[] = [];
  for (let g = 0; g < 30; g++) {
    Math.random = seeded(5000 + g);
    let walls = 0;
    let time = 0;
    let nr = 0;
    for (let i = 0; i < 6; i++) {
      const aim = ((i % 3) - 1) * 0.3;
      const r = await diagnoseBattle({
        seed: null,
        player: { power: 0.7 + (i % 3) * 0.15, aim, tilt: 0 },
        rival: { power: 0.8, aim: -aim, tilt: 0 },
        rivalLoadout: { blade: 'gale-crescent', ratchet: 'tri-lock', bit: 'rush-rubber' },
        maxSeconds: 40,
      });
      walls += r.wallHits.player + r.wallHits.rival;
      time += r.duration;
      nr += r.nearWall.player + r.nearWall.rival;
    }
    wall.push((walls / time) * 10);
    near.push(nr / 12);
    Math.random = seeded(6000 + g);
    const tiers = { light: 0, medium: 0, heavy: 0 };
    let hits = 0;
    let t2 = 0;
    for (let i = 0; i < 6; i++) {
      const aim = ((i % 3) - 1) * 0.3;
      const r = await simulateBattle({ player: { power: 0.7 + (i % 3) * 0.15, aim, tilt: 0 }, rival: { power: 0.8, aim: -aim, tilt: 0 }, maxSeconds: 40, seed: null });
      for (const e of r.battle.impacts) tiers[e.tier as keyof typeof tiers]++;
      hits += r.battle.hits;
      t2 += r.battle.time;
      r.dispose();
    }
    hitRate.push((hits / t2) * 10);
    tierOk.push((hits / t2) * 10 > 2.5 && tiers.light > 0 && tiers.medium + tiers.heavy > 3 && tiers.heavy > 0);
  }
  Math.random = orig;
  const avg = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const out = {
    wallMean: avg(wall),
    wallPass: wall.filter((w) => w < 1.2).length / wall.length,
    nearMean: avg(near),
    nearPass: near.filter((n) => n < 0.04).length / near.length,
    hitRateMean: avg(hitRate),
    tierPass: tierOk.filter(Boolean).length / tierOk.length,
    wall,
  };
  mkdirSync('test-results/motion', { recursive: true });
  writeFileSync(process.env.WALL_OUT ?? 'test-results/motion/wallrate.json', JSON.stringify(out));
});
