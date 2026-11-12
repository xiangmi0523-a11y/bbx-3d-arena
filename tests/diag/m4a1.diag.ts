/// <reference types="node" />
/**
 * M4-A1 物理步频开关的耗时与一致性（docs/engineering/m4-experiment-plan.md §4.2 A1）。
 * 16 个签名矩阵回合（20000 × 20 的场景里每隔 20 个取一个，覆盖 16 种对阵），在 k = 1 / 2 / 4 个子步下各跑一遍：
 * 报告每模拟秒的计算耗时（CI 机器上的 Node，iPhone 另行核实）、终结分布、物理审计（NaN / 穿地）、自转账本残差。
 * 第一组用默认开关（只改步频）；第二组用 A 路线的目标开关（陀螺项、去掉 PD 与显式牵引、平底、去掉合成刮地，g = 80、地面摩擦 × 0.25）。
 * 输出行首 M4A1-。只读：开关在本文件运行期间设置，结束后恢复。
 */
import { test } from 'vitest';
import { GYRO_EXPERIMENT } from '../../src/game/physics/gyro';
import { loadRapier, PHYSICS_EXPERIMENT } from '../../src/game/physics/PhysicsWorld';
import { r2, r3 } from './m4.metrics';
import { matrixScenarios, out, runRound, summarize } from './m5b.shared';

const A_SWITCHES = { enabled: 1, pd: 0, tiltDrive: 1, flatTip: 1, explicitDrive: 0, scrape: 0 };

function withSwitches<T>(gyro: Partial<typeof GYRO_EXPERIMENT>, phys: Partial<typeof PHYSICS_EXPERIMENT>, fn: () => T): T {
  const g0 = { ...GYRO_EXPERIMENT };
  const p0 = { ...PHYSICS_EXPERIMENT };
  Object.assign(GYRO_EXPERIMENT, gyro);
  Object.assign(PHYSICS_EXPERIMENT, phys);
  try {
    return fn();
  } finally {
    Object.assign(GYRO_EXPERIMENT, g0);
    Object.assign(PHYSICS_EXPERIMENT, p0);
  }
}

test('M4-A1 子步耗时与一致性', async () => {
  const R = await loadRapier();
  const scs = matrixScenarios(20000, 20).filter((_, i) => i % 20 === 0);
  const sets: [string, Partial<typeof GYRO_EXPERIMENT>, Partial<typeof PHYSICS_EXPERIMENT>][] = [
    ['default', {}, {}],
    ['A-g80', A_SWITCHES, { gravity: 80, floorFriction: 0.25 }],
  ];
  for (const [name, gyro, phys] of sets)
    for (const k of [1, 2, 4]) {
      const res = withSwitches(gyro, { ...phys, substeps: k }, () => {
        const t0 = Date.now();
        const recs = scs.map((sc) => runRound(R, sc));
        const ms = Date.now() - t0;
        const simSec = recs.reduce((a, x) => a + x.dur, 0);
        const sum = summarize(recs);
        return {
          set: name,
          substeps: k,
          hz: 120 * k,
          rounds: recs.length,
          simSeconds: r2(simSec),
          ms,
          msPerSimSecond: r2(ms / Math.max(1e-9, simSec)),
          msPerFrame: r3(ms / Math.max(1e-9, simSec * 120)),
          counts: sum.counts,
          bad: sum.bad,
          ledgerResidualMax: sum.spinLoss.residual.max,
          durationP50: sum.durationP50,
        };
      });
      out('M4A1-PERF', res);
    }
});
