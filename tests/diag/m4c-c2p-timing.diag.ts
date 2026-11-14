/// <reference types="node" />
/**
 * M4-C · C2-P 耗时（docs/engineering/m4c-c2-preregistration.md §7 M9、§10 停止条件 3）：同一 CI 机器上，每个候选臂与 P0 交替（ABAB…）各 7 轮，
 * 先各预热 1 轮不计；16 个签名矩阵回合（20000 × 20 场景每 20 个取 1 个，覆盖 16 种对阵）；不装探针。
 * 指标 = 每模拟秒耗时（臂会改变回合时长，所以按模拟时间归一）；比值 = 臂的中位 / P0 的中位；> 1.20 触发停止条件 3。输出 C2P-TIMING。
 * 本诊断必须单独运行（不与其他诊断并行）。
 */
import { test } from 'vitest';
import { loadRapier } from '../../src/game/physics/PhysicsWorld';
import { median } from './m4.metrics';
import { emit, withArm, type ArmName } from './m4c-c2p.shared';
import { matrixScenarios, runRound } from './m5b.shared';

test('C2-P 耗时：候选臂 vs P0（同机交替）', async () => {
  const R = await loadRapier();
  const scs = matrixScenarios(20000, 20).filter((_, i) => i % 20 === 0);
  const run = (arm: ArmName) =>
    withArm(arm, () => {
      const t0 = performance.now();
      const recs = scs.map((sc) => runRound(R, sc));
      const ms = performance.now() - t0;
      const sim = recs.reduce((a, x) => a + x.dur, 0);
      const key = JSON.stringify(recs.map((x) => [x.kind, x.finish, x.winner, x.dur, x.sides[0].end, x.sides[1].end]));
      return { ms, sim, key };
    });
  const p0Keys = new Set<string>();
  for (const X of ['Pa', 'Pb', 'Pc'] as ArmName[]) {
    run('P0');
    run(X);
    const a: number[] = [];
    const p: number[] = [];
    const armKeys = new Set<string>();
    let simX = 0;
    let simP = 0;
    for (let i = 0; i < 7; i++) {
      for (const arm of i % 2 === 0 ? (['P0', X] as ArmName[]) : ([X, 'P0'] as ArmName[])) {
        const r = run(arm);
        if (arm === 'P0') {
          p.push(r.ms / r.sim);
          simP = r.sim;
          p0Keys.add(r.key);
        } else {
          a.push(r.ms / r.sim);
          simX = r.sim;
          armKeys.add(r.key);
        }
      }
    }
    const ratio = median(a) / median(p);
    emit('c2p-timing.jsonl', 'C2P-TIMING', { arm: X, rounds: scs.length, simSeconds: { P0: simP, arm: simX }, msPerSimSecond: { P0: p, arm: a }, medianP0: median(p), medianArm: median(a), ratio, stop3: ratio > 1.2, armDeterministic: armKeys.size === 1 });
  }
  emit('c2p-timing.jsonl', 'C2P-TIMING-P0', { deterministic: p0Keys.size === 1 });
}, 3600000);
