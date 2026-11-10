import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BattleSystem } from '../src/game/battle/BattleSystem';
import { CLAW_EXPERIMENT, invInertia, type StrikeBody } from '../src/game/battle/clawStrike';
import type { BeyPhysics } from '../src/game/beys/BeyPhysics';
import { assembleBey } from '../src/game/beys/parts/assemble';
import { SIGNATURE_LIST, SIGNATURES } from '../src/game/beys/parts/catalog';
import type { BeyLoadout } from '../src/game/beys/parts/types';
import { loadRapier, PhysicsWorld } from '../src/game/physics/PhysicsWorld';
import { seeded } from './feelSim';

/**
 * 重击模型（D1 方案 A）与真实 Rapier 的一致性：
 *  1. massProps（解析质心 / 惯量）与 Rapier 的实际冲量响应一致——重击的有效质量与能量审计建立在它上面；
 *  2. 打开实验开关后，只在真实刀刃接触时发生，Rapier 实际施加后两体线动量守恒、动能审计无违规、双方都付出转速代价并记入账本；
 *  3. 默认关闭：不发生任何重击（golden 由 repro 测试逐场保证）。
 * 场景：无场地的世界，测试里直接摆放位置 / 姿态 / 速度（与 contactSampling.test 相同的做法）。
 */
type R = Awaited<ReturnType<typeof loadRapier>>;
let RAP: R;
beforeAll(async () => {
  RAP = await loadRapier();
});
const realRandom = Math.random;
const saved = { ...CLAW_EXPERIMENT };
beforeEach(() => {
  Math.random = seeded(20261111);
});
afterEach(() => {
  Math.random = realRandom;
  Object.assign(CLAW_EXPERIMENT, saved);
});

const q = (phi: number) => ({ x: 0, y: 0, z: Math.sin(phi / 2), w: Math.cos(phi / 2) });

function world(p: BeyLoadout, r: BeyLoadout) {
  const pw = new PhysicsWorld(RAP);
  const b = new BattleSystem(pw, { player: assembleBey(p), rival: assembleBey(r) });
  return { pw, b };
}

function strikeBody(x: BeyPhysics): StrikeBody {
  return { m: x.massProps.mass, c: x.comWorld(), v: x.body.linvel(), w: x.body.angvel(), up: x.up(), Ia: x.massProps.Ia, It: x.massProps.It };
}

describe('重击模型：质量属性与 Rapier 一致', () => {
  for (const sg of SIGNATURE_LIST) {
    it(`${sg.name}：质量、质心、轴向 / 横向惯量与 Rapier 的冲量响应一致（倾斜 0.3 rad）`, () => {
      const { pw, b } = world(sg.loadout, sg.loadout);
      const A = b.launch('player', { power: 0.8, aim: 0, tilt: 0 });
      b.launch('rival', { power: 0.8, aim: 0, tilt: 0 }).body.setTranslation({ x: 30, y: 3, z: 0 }, true);
      A.body.setTranslation({ x: 0, y: 3, z: 0 }, true);
      A.body.setRotation(q(0.3), true);
      const reset = () => {
        A.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        A.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      };
      reset();
      pw.step(); // 让 Rapier 按碰撞体重算质量属性与世界质心（无场地：只受重力）
      reset();
      expect(Math.abs(A.body.mass() - A.massProps.mass) / A.massProps.mass).toBeLessThan(1e-5);
      // 冲量作用在解析质心上：不应产生角速度
      A.body.applyImpulseAtPoint({ x: 1, y: 0.3, z: -0.6 }, A.comWorld(), true);
      const w0 = A.body.angvel();
      expect(Math.hypot(w0.x, w0.y, w0.z)).toBeLessThan(1e-3);
      // 角冲量的响应 = 解析惯量张量的逆
      const body = strikeBody(A);
      for (const t of [
        { x: 0, y: 1, z: 0 },
        { x: 1, y: 0, z: 0 },
        { x: 0.3, y: -0.5, z: 0.8 },
      ]) {
        reset();
        A.body.applyTorqueImpulse(t, true);
        const w = A.body.angvel();
        const e = invInertia(body, t);
        const err = Math.hypot(w.x - e.x, w.y - e.y, w.z - e.z) / Math.hypot(e.x, e.y, e.z);
        expect(err).toBeLessThan(1e-3);
      }
      pw.dispose();
    });
  }
});

/** 两台陀螺悬空并排（沿 x），刀刃外缘重叠 overlap，A 以 vA 接近，都右旋 spin */
function touching(p: BeyLoadout, r: BeyLoadout, overlap: number, vA: number, spin = 140) {
  const { pw, b } = world(p, r);
  pw.beforeStep = (dt) => b.preStep(dt);
  pw.afterStep = (dt) => b.postStep(dt);
  const A = b.launch('player', { power: 0.8, aim: 0, tilt: 0 });
  const B = b.launch('rival', { power: 0.8, aim: 0, tilt: 0 });
  const d = A.spec.blade.radius + B.spec.blade.radius - overlap;
  // 两台刀刃中心等高：用各自的刀刃中心高度对齐
  const y = 3;
  A.body.setTranslation({ x: -d / 2, y: y - A.spec.layers.blade.center, z: 0 }, true);
  B.body.setTranslation({ x: d / 2, y: y - B.spec.layers.blade.center, z: 0 }, true);
  for (const x of [A, B]) x.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
  A.body.setLinvel({ x: vA, y: 0, z: 0 }, true);
  B.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  for (const x of [A, B]) x.body.setAngvel({ x: 0, y: -spin, z: 0 }, true);
  pw.world.propagateModifiedBodyPositionsToColliders();
  return { pw, b, A, B };
}

describe('重击模型：接入 BattleSystem（实验开关）', () => {
  it('打开开关：真实刀刃接触时发生重击；线动量守恒、能量审计无违规、双方掉速记入账本、受击方被沿倾斜法线推开', () => {
    CLAW_EXPERIMENT.enabled = 1;
    CLAW_EXPERIMENT.kappa = 0.2;
    const { pw, b, A, B } = touching(SIGNATURES.lieren.loadout, SIGNATURES.pandun.loadout, 0.004, 2.5);
    for (let s = 0; s < 6 && b.claw.strikes === 0; s++) pw.step();
    expect(b.claw.strikes).toBeGreaterThan(0);
    expect(b.claw.rejectedEnergy).toBe(0);
    expect(b.claw.maxRelDke).toBeLessThanOrEqual(1e-9);
    expect(b.claw.momentumResid).toBeLessThan(1e-3);
    expect(A.ledger.claw).toBeGreaterThan(0);
    expect(B.ledger.claw).toBeGreaterThan(0);
    const vb = B.body.linvel();
    expect(vb.x).toBeGreaterThan(0.5); // 被推开
    expect(Math.abs(vb.z)).toBeGreaterThan(0.01); // 倾斜法线带来的侧向分量
    // 没有直接设置速度：重击后 B 的水平速度不超过“全部闭合速度都转成 B 的速度”的上限
    expect(Math.hypot(vb.x, vb.z)).toBeLessThan(25);
    pw.dispose();
  });

  it('打开开关但没有真实接触（相隔 0.3）：不发生重击', () => {
    CLAW_EXPERIMENT.enabled = 1;
    CLAW_EXPERIMENT.kappa = 0.2;
    const { pw, b } = touching(SIGNATURES.lieren.loadout, SIGNATURES.pandun.loadout, -0.3, 0);
    for (let s = 0; s < 30; s++) pw.step();
    expect(b.claw.strikes).toBe(0);
    pw.dispose();
  });

  it('默认关闭：同样的接触不发生重击（走原有的咬合冲量）', () => {
    expect(CLAW_EXPERIMENT.enabled).toBe(0);
    const { pw, b, A } = touching(SIGNATURES.lieren.loadout, SIGNATURES.pandun.loadout, 0.004, 2.5);
    for (let s = 0; s < 6; s++) pw.step();
    expect(b.claw.strikes).toBe(0);
    expect(A.ledger.claw).toBe(0);
    pw.dispose();
  });
});
