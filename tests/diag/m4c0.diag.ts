/// <reference types="node" />
/**
 * M4-C · C0 验收：同一 CI 机器上执行层路径与旧路径的耗时对比（门槛：变化 ≤ 5%）。
 * 16 个签名矩阵回合（20000 × 20 场景里每 20 个取 1 个，覆盖 16 种对阵），两条路径交替各跑 7 轮（ABAB…，抵消机器漂移），
 * 先各预热 1 轮不计。报告每轮总耗时、每模拟秒耗时、两条路径的中位数与比值。两条路径的回合结果必须逐项相同。输出行首 M4C0-。
 */
import { test } from 'vitest';
import { EXECUTOR_SWITCH } from '../../src/game/beys/motionExecutor';
import { loadRapier } from '../../src/game/physics/PhysicsWorld';
import { median, r3 } from './m4.metrics';
import { matrixScenarios, out, runRound } from './m5b.shared';

test('M4-C C0 耗时：执行层 vs 旧路径（同机交替）', async () => {
  const R = await loadRapier();
  const scs = matrixScenarios(20000, 20).filter((_, i) => i % 20 === 0);
  const run = (legacy: number) => {
    const old = EXECUTOR_SWITCH.legacy;
    EXECUTOR_SWITCH.legacy = legacy;
    try {
      const t0 = performance.now();
      const recs = scs.map((sc) => runRound(R, sc));
      const ms = performance.now() - t0;
      const sim = recs.reduce((a, x) => a + x.dur, 0);
      const key = JSON.stringify(recs.map((x) => [x.kind, x.finish, x.winner, x.dur, x.sides[0].end, x.sides[1].end, x.sides[0].ledger, x.sides[1].ledger]));
      return { ms, sim, key };
    } finally {
      EXECUTOR_SWITCH.legacy = old;
    }
  };
  run(0);
  run(1);
  const exec: number[] = [];
  const legacy: number[] = [];
  let sim = 0;
  let same = true;
  let ref = '';
  for (let i = 0; i < 7; i++) {
    for (const lg of i % 2 === 0 ? [0, 1] : [1, 0]) {
      const r = run(lg);
      (lg ? legacy : exec).push(r.ms);
      sim = r.sim;
      if (!ref) ref = r.key;
      else if (r.key !== ref) same = false;
    }
  }
  const me = median(exec);
  const ml = median(legacy);
  out('M4C0-PERF', {
    rounds: scs.length,
    simSeconds: r3(sim),
    executorMs: exec.map(r3),
    legacyMs: legacy.map(r3),
    executorMedianMs: r3(me),
    legacyMedianMs: r3(ml),
    msPerSimSecond: { executor: r3(me / sim), legacy: r3(ml / sim) },
    ratio: r3(me / ml),
    within5pct: Math.abs(me / ml - 1) <= 0.05,
    resultsIdentical: same,
  });
  if (!same) throw new Error('两条路径的回合结果不同');
});
