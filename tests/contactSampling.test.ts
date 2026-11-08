import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BattleSystem } from '../src/game/battle/BattleSystem';
import { classifyContact, emptyEvidence, queryContact } from '../src/game/battle/contactSampling';
import type { BeyPhysics } from '../src/game/beys/BeyPhysics';
import { assembleBey } from '../src/game/beys/parts/assemble';
import type { BeyLoadout } from '../src/game/beys/parts/types';
import { createArenaPhysics } from '../src/game/arena/ArenaPhysics';
import { loadRapier, PhysicsWorld } from '../src/game/physics/PhysicsWorld';
import { seeded } from './feelSim';

/**
 * Stage A：接触观测层（BattleSystem.sampleContact / contactSampling.ts）。
 * 场景全部用真实 Rapier 与真实陀螺碰撞体；只在测试里直接摆放位置 / 姿态 / 速度。
 */
/** 平衡套装（球头轴心） */
const BAL_LOADOUT_FOR_TEST: BeyLoadout = { blade: 'gale-crescent', disc: 'hex-lock', tip: 'dome-ball' };
type R = Awaited<ReturnType<typeof loadRapier>>;
let RAP: R;
beforeAll(async () => {
  RAP = await loadRapier();
});
const realRandom = Math.random;
beforeEach(() => {
  Math.random = seeded(20261108);
});
afterEach(() => {
  Math.random = realRandom;
});

/** 旧版 early-out 条件（cb4c2c4）：XZ 中心距 > 两台 outerRadius 之和 + 0.12 时不查询 */
const oldEarlyOut = (a: BeyPhysics, b: BeyPhysics) => {
  const pa = a.body.translation();
  const pb = b.body.translation();
  return Math.hypot(pa.x - pb.x, pa.z - pb.z) > a.spec.outerRadius + b.spec.outerRadius + 0.12;
};

/** 无场地的世界：两台陀螺悬空摆放（同时自由下落，相对位置一步内不变），沿 x 轴相隔 d，各自向对方倾斜 tilt */
function scene(d: number, tilt: number, vRel = 0) {
  const pw = new PhysicsWorld(RAP);
  const b = new BattleSystem(pw, { player: assembleBey(BAL_LOADOUT_FOR_TEST), rival: assembleBey(BAL_LOADOUT_FOR_TEST) });
  pw.beforeStep = (dt) => b.preStep(dt);
  pw.afterStep = (dt) => b.postStep(dt);
  const A = b.launch('player', { power: 0.8, aim: 0, tilt: 0 });
  const B = b.launch('rival', { power: 0.8, aim: 0, tilt: 0 });
  // 绕 z 轴转 φ：up (0,1,0) → (−sinφ, cosφ, 0)。A 在 −x 侧向 +x 倾（φ = −tilt），B 在 +x 侧向 −x 倾（φ = +tilt）
  const q = (phi: number) => ({ x: 0, y: 0, z: Math.sin(phi / 2), w: Math.cos(phi / 2) });
  A.body.setTranslation({ x: -d / 2, y: 3, z: 0 }, true);
  B.body.setTranslation({ x: d / 2, y: 3, z: 0 }, true);
  A.body.setRotation(q(-tilt), true);
  B.body.setRotation(q(tilt), true);
  A.body.setLinvel({ x: vRel / 2, y: 0, z: 0 }, true);
  B.body.setLinvel({ x: -vRel / 2, y: 0, z: 0 }, true);
  for (const x of [A, B]) x.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  // 摆放后让碰撞体位置同步（只为步前的形状距离查询；Rapier 在 step 里本来也会同步）
  pw.world.propagateModifiedBodyPositionsToColliders();
  return { pw, b, A, B };
}

/** 摆放时（步前）两台刀刃的三维形状距离 */
function bladeDist(A: BeyPhysics, B: BeyPhysics): number {
  const c = A.bladeCollider.contactCollider(B.bladeCollider, 1);
  return c ? c.distance : Infinity;
}

/** 二分找刀刃形状距离 = target 的中心距 */
function findSeparation(tilt: number, target: number): number {
  let lo = 0.5;
  let hi = 2.5;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const { pw, A, B } = scene(mid, tilt);
    const dd = bladeDist(A, B);
    pw.dispose();
    if (dd > target) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

describe('Stage A：接触观测层', () => {
  it('倾斜刀刃边缘接触：旧 early-out 会跳过，新门槛执行查询并观测到几何接触', () => {
    const tilt = 0.55;
    const d = findSeparation(tilt, -0.001);
    const { pw, b, A, B } = scene(d, tilt);
    expect(bladeDist(A, B)).toBeLessThan(0);
    // 旧条件下这一步会在查询之前返回
    expect(oldEarlyOut(A, B)).toBe(true);
    pw.step();
    expect(oldEarlyOut(A, B)).toBe(true);
    const e = b.contactEvidence;
    expect(e.queried).toBe(true);
    expect(e.skipped).toBe(null);
    expect(e.valid).toBe(true);
    expect(e.solverContacts).toBeGreaterThan(0);
    expect(e.minSolverDist).toBeLessThanOrEqual(0);
    expect(b.contactClass.geometric).toBe(true);
    expect(b.contact.state.phase).not.toBe('idle');
    pw.dispose();
  });

  it('零冲量穿透：几何接触不因冲量为零被归为无接触（分类函数 + 真实对局）', () => {
    // 分类函数：signed distance ≤ 0 即几何接触，与冲量无关
    const e = { ...emptyEvidence(), queried: true, valid: true, manifolds: 1, contacts: 1, solverContacts: 1, minSolverDist: -0.0008, impulse: 0 };
    expect(classifyContact(e)).toEqual({ geometric: true, predictive: false, impulseResponse: false });
    expect(classifyContact({ ...e, minSolverDist: 0 }).geometric).toBe(true);
    // 真实对局（固定种子）：出现几何接触但零冲量的步，接触反馈在这些步上按“有接触”处理
    const pw = new PhysicsWorld(RAP);
    createArenaPhysics(pw);
    const bal = assembleBey(BAL_LOADOUT_FOR_TEST);
    const b = new BattleSystem(pw, { player: bal, rival: assembleBey(BAL_LOADOUT_FOR_TEST) });
    pw.beforeStep = (dt) => b.preStep(dt);
    pw.afterStep = (dt) => b.postStep(dt);
    b.launch('player', { power: 0.65, aim: 0, tilt: 0 });
    b.launch('rival', { power: 0.8, aim: -0.7, tilt: 0 });
    let zeroImpulseGeom = 0;
    let feedbackTouched = 0;
    for (let s = 0; s < 120 * 40 && !b.result; s++) {
      const before = b.contact.state.touchSteps;
      const ep = b.contact.state.episode;
      pw.step();
      const c = b.contactClass;
      if (c.geometric && !c.impulseResponse) {
        zeroImpulseGeom++;
        expect(b.contactEvidence.impulse).toBe(0);
        expect(b.contactEvidence.minSolverDist).toBeLessThanOrEqual(0);
        // 本步算作接触：要么累计接触步数 +1，要么开启了新接触段
        if (b.contact.state.touchSteps === before + 1 || b.contact.state.episode === ep + 1) feedbackTouched++;
      }
    }
    expect(zeroImpulseGeom).toBeGreaterThan(0);
    expect(feedbackTouched).toBe(zeroImpulseGeom);
    expect(b.contactStats.geometricZeroImpulse).toBe(zeroImpulseGeom);
    pw.dispose();
  });

  it('正间隙（预测距离内）：记为预测接触间隙，不是几何接触', () => {
    // 直立、静止，刀刃间隙 1 mm（Rapier 预测距离 2 mm）
    const d = findSeparation(0, 0.001);
    const { pw, b, A, B } = scene(d, 0);
    expect(bladeDist(A, B)).toBeGreaterThan(0.0005);
    pw.step();
    const e = b.contactEvidence;
    expect(e.queried).toBe(true);
    expect(e.solverContacts).toBeGreaterThan(0);
    expect(e.minSolverDist).toBeGreaterThan(0);
    expect(b.contactClass.predictive).toBe(true);
    expect(b.contactClass.geometric).toBe(false);
    expect(b.contactClass.impulseResponse).toBe(false);
    expect(b.contact.state.phase).toBe('idle');
    pw.dispose();
  });

  it('普通分离：近处查询无接触；远处由包围球门槛跳过，不误判为接触', () => {
    const near = findSeparation(0, 0.1);
    for (const [d, expectQueried] of [
      [near, true],
      [4, false],
    ] as const) {
      const { pw, b } = scene(d, 0);
      pw.step();
      const e = b.contactEvidence;
      expect(e.queried).toBe(expectQueried);
      expect(e.skipped).toBe(expectQueried ? null : 'bound');
      expect(e.manifolds).toBe(0);
      expect(b.contactClass).toEqual({ geometric: false, predictive: false, impulseResponse: false });
      expect(b.contact.state.phase).toBe('idle');
      if (expectQueried) expect(e.shapeDistance).toBe(Infinity); // 10 cm > 形状查询范围 5 cm
      pw.dispose();
    }
  });

  it('包围球门槛不漏查：固定种子整场，每个被跳过的步无条件查询都没有接触流形', () => {
    const pw = new PhysicsWorld(RAP);
    createArenaPhysics(pw);
    const b = new BattleSystem(pw, { player: assembleBey(BAL_LOADOUT_FOR_TEST), rival: assembleBey(BAL_LOADOUT_FOR_TEST) });
    pw.beforeStep = (dt) => b.preStep(dt);
    pw.afterStep = (dt) => b.postStep(dt);
    const A = b.launch('player', { power: 0.9, aim: 0.3, tilt: 0 });
    const B = b.launch('rival', { power: 0.9, aim: -0.3, tilt: 0 });
    let skipped = 0;
    for (let s = 0; s < 120 * 40 && !b.result; s++) {
      pw.step();
      if (b.contactEvidence.skipped) {
        skipped++;
        const full = emptyEvidence();
        queryContact(pw.world, A.colliders, B.colliders, full);
        expect(full.manifolds).toBe(0);
      }
    }
    expect(skipped).toBeGreaterThan(100);
    pw.dispose();
  });
});
