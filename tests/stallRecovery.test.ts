import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { R1C_TUNING } from '../src/game/battle/stallRecovery';
import { loadRapier, PHYSICS_DT } from '../src/game/physics/PhysicsWorld';
import { seeded } from './motion/motionSim';
import { scenariosV2, setup } from './diag/stallprobe2.shared';

/**
 * Stage B：R1c 受控恢复（独立通道）的边界。场景与种子来自探针 V2 矩阵（固定种子、真实 Rapier）。
 */
type R = Awaited<ReturnType<typeof loadRapier>>;
let RAP: R;
beforeAll(async () => {
  RAP = await loadRapier();
});
const saved = { ...R1C_TUNING };
afterEach(() => Object.assign(R1C_TUNING, saved));
const scn = (name: string) => scenariosV2().find((s) => s.name === name)!;

function run(name: string, seconds: number, onStep?: (ctx: ReturnType<typeof setup>, t: number) => void) {
  const sc = scn(name);
  const orig = Math.random;
  Math.random = seeded(sc.seed);
  try {
    const ctx = setup(RAP, sc);
    for (let s = 0; s < seconds / PHYSICS_DT && !ctx.b.result; s++) {
      ctx.pw.step();
      onStep?.(ctx, (s + 1) * PHYSICS_DT);
    }
    return ctx;
  } finally {
    Math.random = orig;
  }
}

describe('Stage B：R1c 受控恢复', () => {
  it('关闭时不介入：针尖对针尖长僵持场次没有任何恢复记录', () => {
    R1C_TUNING.enabled = 0;
    const { b, pw } = run('LONG S/S#0', 30);
    expect(b.recovery.log.length).toBe(0);
    expect(b.recovery.state).toBe('idle');
    pw.dispose();
  });

  it('只针对针尖对针尖：其他陀尖组合整场不进入 dwell', () => {
    for (const name of ['BvB#4', 'SvA#1', 'AvD#1', 'CTRL center BB#0']) {
      let entered = false;
      const { b, pw } = run(name, 40, (c) => {
        if (c.b.recovery.state !== 'idle') entered = true;
      });
      expect(entered, name).toBe(false);
      expect(b.recovery.log.length, name).toBe(0);
      pw.dispose();
    }
  });

  it('上限与方向：施力方向不背离对手，速度 / 时长 / 累计 Δv 不超上限，退出后冷却再 dwell', () => {
    const T = R1C_TUNING;
    let pushSteps = 0;
    const { b, pw } = run('LONG S/S#0', 50, (c) => {
      const r = c.b.recovery;
      for (const p of r.push) {
        if (!p.on) continue;
        pushSteps++;
        // 施力方向与拦截方向夹角 < 90°
        expect(p.dx * p.tx + p.dz * p.tz).toBeGreaterThan(0);
        expect(Math.hypot(p.dx, p.dz)).toBeCloseTo(1, 6);
      }
    });
    const log = b.recovery.log;
    expect(log.length).toBeGreaterThan(0);
    expect(pushSteps).toBeGreaterThan(0);
    for (const a of log) {
      expect(a.t1 - a.t0).toBeLessThanOrEqual(T.maxTime + PHYSICS_DT);
      for (const dv of a.deltaV) expect(dv).toBeLessThanOrEqual(T.maxDeltaV + 1e-9);
      // 恢复期间的最大水平速度：辅助只在沿施力方向速度 < maxSpeed 时施加，本场不超过 maxSpeed + 0.15
      expect(a.maxSpeed).toBeLessThan(T.maxSpeed + 0.15);
      expect(a.biasAngleMax).toBeLessThan(90);
    }
    // 两次启动之间至少隔 冷却 + dwell
    for (let i = 1; i < log.length; i++) expect(log[i].t0 - log[i - 1].t1).toBeGreaterThanOrEqual(T.cooldown + T.dwellTime - PHYSICS_DT * 2);
    pw.dispose();
  });

  it('进入不要求真实接触：启动时刀刃间隙可为正，且启动前已持续 dwellTime 的低速分类', () => {
    const { b, pw } = run('LONG S/S#0', 50);
    const log = b.recovery.log;
    expect(log.some((a) => a.gap0 > 0)).toBe(true);
    expect(log[0].t0).toBeGreaterThan(R1C_TUNING.dwellTime);
    for (const a of log) for (const v of a.speed0) expect(v).toBeLessThan(R1C_TUNING.slowSpeed);
    pw.dispose();
  });

  it('转速比例低于下限后不再启动（终局交给原有机制）', () => {
    const { b, pw } = run('LONG S/S#0', 90);
    expect(b.recovery.log.length).toBeGreaterThan(0);
    for (const a of b.recovery.log) for (const r of a.spinRatio0) expect(r).toBeGreaterThanOrEqual(R1C_TUNING.minSpinRatio);
    pw.dispose();
  });
});
