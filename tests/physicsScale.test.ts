import { afterEach, describe, expect, it } from 'vitest';
import { createArenaPhysics } from '../src/game/arena/ArenaPhysics';
import { BattleSystem } from '../src/game/battle/BattleSystem';
import { BURST_TUNING } from '../src/game/battle/burst';
import type { BeyPhysics, SpinLedger } from '../src/game/beys/BeyPhysics';
import { assembleBey } from '../src/game/beys/parts/assemble';
import { SIGNATURE_LIST } from '../src/game/beys/parts/catalog';
import { rivalCommand } from '../src/game/launcher/launch';
import { GRAVITY, loadRapier, PhysicsWorld, PHYSICS_DT, PHYSICS_EXPERIMENT } from '../src/game/physics/PhysicsWorld';
import { seeded } from './feelSim';

/**
 * M4 物理尺度开关（docs/engineering/m4-experiment-plan.md §4.2 A1，src/game/physics/PhysicsWorld.ts PHYSICS_EXPERIMENT）：
 *  - 默认值 = 现有行为（golden 由 repro 测试逐场保证不变）；
 *  - substeps = k：一次 step() 依次执行 k 个完整子步（beforeStep → world.step → 接触观测 → afterStep），dt 之和 = 1/120 s；
 *  - gravity：自由落体与 Rapier 的辛欧拉离散解一致；floorFriction：场地地面摩擦系数按倍数缩放；
 *  - k = 2 / 4 下完整回合：爆裂观测按子步计时、每个子步都收到本子步的实测法向冲量（累计 = 各子步之和）、无 NaN、自转账本残差 ≤ 1%。
 */

const saved = { ...PHYSICS_EXPERIMENT };
afterEach(() => Object.assign(PHYSICS_EXPERIMENT, saved));

function withPhysics<T>(x: Partial<typeof PHYSICS_EXPERIMENT>, fn: () => T): T {
  Object.assign(PHYSICS_EXPERIMENT, x);
  try {
    return fn();
  } finally {
    Object.assign(PHYSICS_EXPERIMENT, saved);
  }
}

const ledgerResidual = (b: BeyPhysics) => {
  const L = b.ledger as SpinLedger;
  const sum = (Object.keys(L) as (keyof SpinLedger)[]).reduce((a, k) => a + (k === 'contactGain' ? -L[k] : L[k]), 0);
  return Math.abs(b.launchSpin - b.spin - sum) / Math.max(1, b.launchSpin);
};

describe('M4-A1 物理尺度开关', () => {
  it('默认值 = 现有行为：1 个子步、重力 20、地面摩擦 × 1', async () => {
    expect(PHYSICS_EXPERIMENT).toEqual({ substeps: 1, gravity: 20, floorFriction: 1 });
    expect(PHYSICS_EXPERIMENT.gravity).toBe(-GRAVITY);
    const R = await loadRapier();
    const pw = new PhysicsWorld(R);
    expect(pw.stepDt).toBe(PHYSICS_DT);
    expect(pw.world.timestep).toBeCloseTo(PHYSICS_DT, 7);
    expect(pw.world.gravity.y).toBe(GRAVITY);
    pw.dispose();
  });

  it('子步：一次 step() 依次执行 k 个完整子步，每步 dt = 1/(120k)，dt 之和 = 1/120 s', async () => {
    const R = await loadRapier();
    for (const k of [1, 2, 4]) {
      withPhysics({ substeps: k }, () => {
        const pw = new PhysicsWorld(R);
        expect(pw.substeps).toBe(k);
        expect(pw.stepDt).toBe(PHYSICS_DT / k);
        expect(pw.world.timestep).toBeCloseTo(PHYSICS_DT / k, 7);
        const calls: string[] = [];
        let sum = 0;
        pw.beforeStep = (dt) => {
          calls.push('b');
          sum += dt;
          expect(dt).toBe(pw.stepDt);
        };
        pw.afterStep = (dt) => {
          calls.push('a');
          expect(dt).toBe(pw.stepDt);
        };
        pw.step();
        expect(calls.join('')).toBe('ba'.repeat(k));
        expect(Math.abs(sum - PHYSICS_DT)).toBeLessThan(1e-15);
        pw.dispose();
      });
    }
  });

  it('重力：自由落体 0.5 s 接近 ½·g·t²，且下落距离与 g 成正比（g = 20 / 80，k = 1 / 4）', async () => {
    const R = await loadRapier();
    const drop = (g: number, k: number) =>
      withPhysics({ gravity: g, substeps: k }, () => {
        const pw = new PhysicsWorld(R, { observeContacts: false });
        const body = pw.world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(0, 100, 0));
        pw.world.createCollider(R.ColliderDesc.ball(0.1), body);
        for (let i = 0; i < 60; i++) pw.step();
        const d = 100 - body.translation().y;
        pw.dispose();
        return d;
      });
    const T = 60 * PHYSICS_DT;
    for (const [g, k] of [
      [20, 1],
      [80, 1],
      [80, 4],
    ]) {
      const d = drop(g, k);
      // 离散积分与连续解的差 ~ g·t·dt 量级，0.5 s 内 < 2%
      expect(Math.abs(d - 0.5 * g * T * T) / (0.5 * g * T * T)).toBeLessThan(0.02);
    }
    // 同一步长下下落距离严格与 g 成正比（重力确实按开关设置）
    expect(Math.abs(drop(80, 1) / drop(20, 1) - 4)).toBeLessThan(1e-4);
  });

  it('地面摩擦：createArenaPhysics 的碗面摩擦 = 0.5 × floorFriction', async () => {
    const R = await loadRapier();
    for (const f of [1, 0.25]) {
      withPhysics({ floorFriction: f }, () => {
        const pw = new PhysicsWorld(R);
        createArenaPhysics(pw);
        const found: { friction(): number }[] = [];
        pw.world.colliders.forEach((c: { shapeType(): number; friction(): number }) => {
          if (c.shapeType() === R.ShapeType.TriMesh) found.push(c);
        });
        expect(found.length).toBe(1);
        expect(found[0].friction()).toBeCloseTo(0.5 * f, 6);
        pw.dispose();
      });
    }
  });

  it('k = 2 / 4 的完整回合：爆裂观测按子步计时、每个子步都收到本子步的法向冲量，无 NaN，账本残差 ≤ 1%', async () => {
    const R = await loadRapier();
    const lieren = SIGNATURE_LIST.find((s) => s.key === 'lieren')!;
    const pandun = SIGNATURE_LIST.find((s) => s.key === 'pandun')!;
    for (const k of [2, 4]) {
      withPhysics({ substeps: k }, () => {
        const orig = Math.random;
        Math.random = seeded(4242);
        try {
          const pw = new PhysicsWorld(R);
          createArenaPhysics(pw);
          const battle = new BattleSystem(pw, { player: assembleBey(lieren.loadout), rival: assembleBey(pandun.loadout) });
          // 爆裂接触段的保持时长按子步时长换算成步数
          const holdSteps = (battle.burst as unknown as { episodes: { holdSteps: number } }).episodes.holdSteps;
          expect(holdSteps).toBe(Math.round(BURST_TUNING.holdTime / (PHYSICS_DT / k)));
          let subSteps = 0;
          let fed = 0;
          let observed = 0;
          // 包一层 BurstObserver.step：记录每个子步喂给它的冲量；同时独立读取 ContactService 的本子步身体级冲量
          const burst = battle.burst!;
          const step0 = burst.step.bind(burst);
          burst.step = (s: number, imp: number, spin?: [number, number]) => {
            fed += imp;
            return step0(s, imp, spin);
          };
          pw.beforeStep = (dt) => battle.preStep(dt);
          pw.afterStep = (dt) => {
            subSteps++;
            // 回合判定之前的每个子步，BattleSystem 都把本子步的身体级法向冲量交给爆裂观测
            if (!battle.result) observed += pw.contacts?.bodyPair('player', 'rival')?.normalImpulse ?? 0;
            battle.postStep(dt);
          };
          const rnd = seeded(77);
          const A = battle.launch('player', { power: 0.8, aim: 0.1, tilt: 0 });
          const B = battle.launch('rival', rivalCommand(rnd));
          const frames = Math.round(20 / PHYSICS_DT);
          let f = 0;
          for (; f < frames && !battle.result; f++) {
            pw.step();
            for (const b of [A, B]) {
              const p = b.body.translation();
              const v = b.body.linvel();
              expect(Number.isFinite(p.x + p.y + p.z + v.x + v.y + v.z)).toBe(true);
            }
          }
          expect(subSteps).toBe(f * k);
          expect(observed).toBeGreaterThan(0);
          expect(Math.abs(fed - observed)).toBeLessThan(1e-9 * Math.max(1, observed));
          expect(ledgerResidual(A)).toBeLessThan(0.01);
          expect(ledgerResidual(B)).toBeLessThan(0.01);
          pw.dispose();
        } finally {
          Math.random = orig;
        }
      });
    }
  });
});
