import { describe, expect, it } from 'vitest';
import { STALL_ROLL, StallRollGate, type StallRollInput } from '../src/game/battle/stallRoll';
import { BEY_TUNING } from '../src/game/beys/BeyPhysics';
import { loadRapier, PHYSICS_DT } from '../src/game/physics/PhysicsWorld';
import { seeded } from './motion/motionSim';
import { scenariosV2, setup } from './diag/stallprobe2.shared';

const base = (): StallRollInput => ({ bothNeedle: true, contact: false, speedA: 0.05, speedB: 0.05, spinRatioA: 0.8, spinRatioB: 0.8, breakoutA: 0, breakoutB: 0, wobbleFor: 0 });
const dt = PHYSICS_DT;
const run = (g: StallRollGate, s: StallRollInput, seconds: number) => {
  for (let k = 0; k < Math.round(seconds / dt); k++) g.step(s, dt);
};

describe('针尖僵持自适应滚动阻力门控', () => {
  it('条件持续满 3 s 才确认，确认后倍率 0.5', () => {
    const g = new StallRollGate();
    run(g, base(), 2.9);
    expect(g.confirmed).toBe(false);
    expect(g.scale).toBe(1);
    run(g, base(), 0.2);
    expect(g.confirmed).toBe(true);
    expect(g.scale).toBe(STALL_ROLL.scale);
    expect(g.entries).toBe(1);
  });

  it('任一条件失败立即恢复原阻力并重新计时', () => {
    const fails: Partial<StallRollInput>[] = [
      { bothNeedle: false },
      { contact: true },
      { speedA: 0.4 },
      { speedB: 0.5 },
      { spinRatioA: 0.39 },
      { spinRatioB: 0.2 },
      { breakoutA: 0.1 },
      { breakoutB: 0.7 },
      { wobbleFor: 0.01 },
    ];
    for (const f of fails) {
      const g = new StallRollGate();
      run(g, base(), 4);
      expect(g.confirmed).toBe(true);
      g.step({ ...base(), ...f }, dt);
      expect(g.confirmed, JSON.stringify(f)).toBe(false);
      expect(g.scale).toBe(1);
      expect(g.dwell).toBe(0);
    }
  });

  it('接触后要隔 6 步以上才开始计时', () => {
    const g = new StallRollGate();
    g.step({ ...base(), contact: true }, dt);
    for (let k = 0; k < STALL_ROLL.miss; k++) g.step(base(), dt);
    expect(g.dwell).toBe(0);
    g.step(base(), dt);
    expect(g.dwell).toBeGreaterThan(0);
  });

  it('低转速比例（< 0.4）永远不触发', () => {
    const g = new StallRollGate();
    run(g, { ...base(), spinRatioA: 0.3 }, 20);
    expect(g.confirmedSteps).toBe(0);
  });

  it('对局：只在确认僵持时降低针尖滚动阻力，非针尖组合从不触发', async () => {
    const R = await loadRapier();
    // 通用僵持脱困开启时针尖对针尖不会进入确认僵持；这里临时关闭它，只为覆盖门控路径
    const savedBreak = BEY_TUNING.stallBreak;
    BEY_TUNING.stallBreak = 0;
    try {
    const scs = scenariosV2();
    for (const name of ['NNPOW 0.3#0', 'CTRL center BB#0', 'CTRL center NR#0']) {
      const sc = scs.find((x) => x.name === name)!;
      const orig = Math.random;
      Math.random = seeded(sc.seed);
      try {
        const { pw, b, A, B } = setup(R, sc);
        let scaled = 0;
        let wrong = 0;
        for (let s = 0; s < 60 / PHYSICS_DT && !b.result; s++) {
          pw.step();
          for (const x of [A, B]) {
            if (x.rollScale !== 1) scaled++;
            if (x.rollScale !== (b.stallRoll.confirmed ? STALL_ROLL.scale : 1)) wrong++;
          }
        }
        expect(wrong, name).toBe(0);
        if (name.startsWith('NN')) expect(scaled, name).toBeGreaterThan(0);
        else expect(scaled, name).toBe(0);
        pw.dispose();
      } finally {
        Math.random = orig;
      }
    }
    } finally {
      BEY_TUNING.stallBreak = savedBreak;
    }
  });
});
