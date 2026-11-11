import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createArenaPhysics } from '../src/game/arena/ArenaPhysics';
import { BeyPhysics, type SpinLedger } from '../src/game/beys/BeyPhysics';
import { assembleBey } from '../src/game/beys/parts/assemble';
import { SIGNATURE_LIST } from '../src/game/beys/parts/catalog';
import { computeLaunch } from '../src/game/launcher/launch';
import { emptyGyroState, GYRO_EXPERIMENT, gyroRecover, gyroStep, type GyroState, type V3 } from '../src/game/physics/gyro';
import { GRAVITY, loadRapier, PhysicsWorld, PHYSICS_DT } from '../src/game/physics/PhysicsWorld';
import { seeded } from './feelSim';

/**
 * M4-B0 陀螺项（src/game/physics/gyro.ts，docs/engineering/m4-experiment-plan.md §4 的 T1–T3）：
 *  T0（纯逻辑）：与精确刚体转动组合时，无力矩对称刚体的角动量逐步守恒；
 *  T1（Rapier）：无重力自由圆盘，角动量 2 s 相对漂移 < 0.1%（Rapier 单独约 3.8%）；
 *  T2（Rapier）：球铰支点上的重陀螺，ω = 8 ω_c 时平均进动角速度与 m g l / (I_a ω) 相差 < 10%；1.5 ω_c 保持住、0.6 ω_c 倒下；
 *  T3（Rapier + BeyPhysics）：场地内四个签名构筑（陀螺项开、自稳 PD 关、牵引按实际倾斜），10 s 无 NaN、账本残差 ≤ 1%、高转速时不倒。
 * 默认开关全部关闭（golden 由 repro 测试逐场保证不变）。
 */

type R = Awaited<ReturnType<typeof loadRapier>>;
const DT = PHYSICS_DT;
const saved = { ...GYRO_EXPERIMENT };
afterEach(() => Object.assign(GYRO_EXPERIMENT, saved));

interface Q {
  x: number;
  y: number;
  z: number;
  w: number;
}
const upOf = (q: Q): V3 => ({ x: 2 * (q.x * q.y - q.w * q.z), y: 1 - 2 * (q.x * q.x + q.z * q.z), z: 2 * (q.y * q.z + q.w * q.x) });
/** 世界系角动量 L = I_t ω + (I_a − I_t)(ω·û) û */
function angMom(w: V3, u: V3, Ia: number, It: number): V3 {
  const k = (Ia - It) * (w.x * u.x + w.y * u.y + w.z * u.z);
  return { x: It * w.x + k * u.x, y: It * w.y + k * u.y, z: It * w.z + k * u.z };
}
const norm = (v: V3) => Math.hypot(v.x, v.y, v.z);
const sub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });

/** 按恒定角速度 w 精确转动 dt 后的四元数（与刚体引擎一步的姿态积分相同的“恒定角速度”假设） */
function rotate(q: Q, w: V3, dt: number): Q {
  const ang = norm(w) * dt;
  if (ang < 1e-15) return q;
  const s = Math.sin(ang / 2) / norm(w);
  const r = { x: w.x * s, y: w.y * s, z: w.z * s, w: Math.cos(ang / 2) };
  return {
    w: r.w * q.w - r.x * q.x - r.y * q.y - r.z * q.z,
    x: r.w * q.x + r.x * q.w + r.y * q.z - r.z * q.y,
    y: r.w * q.y - r.x * q.z + r.y * q.w + r.z * q.x,
    z: r.w * q.z + r.x * q.y - r.y * q.x + r.z * q.w,
  };
}

describe('陀螺项：纯逻辑（T0）', () => {
  it('无力矩对称刚体：与恒定角速度姿态积分组合后，角动量与动能逐步守恒（机器精度）', () => {
    const Ia = 0.375;
    const It = 0.198;
    let q: Q = { x: 0, y: 0, z: 0, w: 1 };
    let w: V3 = { x: 4, y: 100, z: 0 };
    const st = emptyGyroState();
    const L0 = angMom(w, upOf(q), Ia, It);
    const E0 = 0.5 * (w.x * L0.x + w.y * L0.y + w.z * L0.z);
    let maxL = 0;
    let maxE = 0;
    for (let s = 0; s < 240; s++) {
      const u = upOf(q);
      const e = gyroStep(w, u, Ia, It, DT, st);
      q = rotate(q, e, DT);
      w = gyroRecover(e, upOf(q), st);
      const L = angMom(w, upOf(q), Ia, It);
      maxL = Math.max(maxL, norm(sub(L, L0)) / norm(L0));
      maxE = Math.max(maxE, Math.abs(0.5 * (w.x * L.x + w.y * L.y + w.z * L.z) - E0) / E0);
    }
    expect(maxL).toBeLessThan(1e-9);
    expect(maxE).toBeLessThan(1e-9);
  });

  it('没有横向角速度（纯自转）时 ω_eff = ω，什么都不改', () => {
    const st = emptyGyroState();
    const u = { x: 0, y: 1, z: 0 };
    const e = gyroStep({ x: 0, y: -140, z: 0 }, u, 0.45, 0.3, DT, st);
    expect(Math.abs(e.x) + Math.abs(e.z)).toBeLessThan(1e-9);
    expect(e.y).toBeCloseTo(-140, 9);
    const back = gyroRecover(e, u, st);
    expect(norm(sub(back, { x: 0, y: -140, z: 0 }))).toBeLessThan(1e-9);
  });
});

describe('陀螺项：Rapier（T1 / T2）', () => {
  let RAP: R;
  beforeAll(async () => {
    RAP = await loadRapier();
  });

  /** 每步之前调用：恢复真实角速度 → 换算等效角速度交给 Rapier */
  function driver(body: InstanceType<R['RigidBody']>, Ia: number, It: number, st: GyroState) {
    return () => {
      const u = upOf(body.rotation());
      const w = gyroRecover(body.angvel(), u, st);
      body.setAngvel(gyroStep(w, u, Ia, It, DT, st), true);
    };
  }

  function freeDisk(withGyro: boolean) {
    const world = new RAP.World({ x: 0, y: 0, z: 0 });
    world.timestep = DT;
    const m = 3;
    const rad = 0.5;
    const hh = 0.1;
    const body = world.createRigidBody(RAP.RigidBodyDesc.dynamic().setCanSleep(false).setLinearDamping(0).setAngularDamping(0));
    world.createCollider(RAP.ColliderDesc.cylinder(hh, rad).setMass(m), body);
    const Ia = (m * rad * rad) / 2;
    const It = (m * (3 * rad * rad + 4 * hh * hh)) / 12;
    world.step(); // 让 Rapier 先算出质量属性
    body.setAngvel({ x: 4, y: 100, z: 0 }, true);
    const st = emptyGyroState();
    const pre = driver(body, Ia, It, st);
    const trueW = () => (withGyro ? gyroRecover(body.angvel(), upOf(body.rotation()), st) : body.angvel());
    const L0 = angMom(trueW(), upOf(body.rotation()), Ia, It);
    let drift = 0;
    for (let s = 0; s < 240; s++) {
      if (withGyro) pre();
      world.step();
      const L = angMom(trueW(), upOf(body.rotation()), Ia, It);
      drift = Math.max(drift, norm(sub(L, L0)) / norm(L0));
    }
    world.free();
    return drift;
  }

  it('T1 无重力自由圆盘：补上陀螺项后角动量 2 s 漂移 < 0.1%；Rapier 单独 > 1%', () => {
    const off = freeDisk(false);
    const on = freeDisk(true);
    console.log(`[T1] 角动量相对漂移：Rapier 单独 ${off.toFixed(4)}，补上陀螺项 ${on.toExponential(2)}`);
    expect(off).toBeGreaterThan(0.01);
    expect(on).toBeLessThan(1e-3);
  });

  /** 球铰支点上的重陀螺：圆盘（m 3、r 0.5、半高 0.1）在支点上方 l 处，初始倾角 θ0、只有自转 ω */
  function heavyTop(omegaOverCrit: number, withGyro = true) {
    const world = new RAP.World({ x: 0, y: GRAVITY, z: 0 });
    world.timestep = DT;
    const m = 3;
    const rad = 0.5;
    const hh = 0.1;
    const l = 0.3;
    const g = -GRAVITY;
    const Ia = (m * rad * rad) / 2;
    const It = (m * (3 * rad * rad + 4 * hh * hh)) / 12;
    const itPivot = It + m * l * l;
    const wc = Math.sqrt(4 * m * g * l * itPivot) / Ia;
    const w0 = omegaOverCrit * wc;
    const th0 = 0.2;
    const q0 = { x: Math.sin(th0 / 2), y: 0, z: 0, w: Math.cos(th0 / 2) };
    const pivot = world.createRigidBody(RAP.RigidBodyDesc.fixed().setTranslation(0, 3, 0));
    const body = world.createRigidBody(RAP.RigidBodyDesc.dynamic().setTranslation(0, 3, 0).setRotation(q0).setCanSleep(false).setLinearDamping(0).setAngularDamping(0));
    world.createCollider(RAP.ColliderDesc.cylinder(hh, rad).setMass(m).setTranslation(0, l, 0), body);
    world.createImpulseJoint(RAP.JointData.spherical({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }), pivot, body, true);
    const u0 = upOf(q0);
    body.setAngvel({ x: u0.x * w0, y: u0.y * w0, z: u0.z * w0 }, true);
    const st = emptyGyroState();
    const pre = driver(body, Ia, It, st);
    let maxTilt = 0;
    let azPrev = 0;
    let azSum = 0;
    for (let s = 1; s <= Math.round(3.5 / DT); s++) {
      if (withGyro) pre();
      world.step();
      const u = upOf(body.rotation());
      const tilt = Math.acos(Math.max(-1, Math.min(1, u.y)));
      maxTilt = Math.max(maxTilt, tilt);
      const az = Math.atan2(u.z, u.x);
      if (s === Math.round(0.5 / DT)) azPrev = az;
      else if (s > Math.round(0.5 / DT)) {
        azSum += Math.atan2(Math.sin(az - azPrev), Math.cos(az - azPrev));
        azPrev = az;
      }
    }
    world.free();
    return { wc, w0, maxTilt, precession: Math.abs(azSum) / 3, theory: (m * g * l) / (Ia * w0) };
  }

  it('T2 重陀螺：ω = 8 ω_c 时平均进动角速度与 m g l / (I_a ω) 相差 < 10%', () => {
    const r = heavyTop(8);
    const off = heavyTop(8, false);
    console.log(`[T2] ω_c ${r.wc.toFixed(2)}，ω ${r.w0.toFixed(1)}：进动 ${r.precession.toFixed(4)} rad/s（理论 ${r.theory.toFixed(4)}；Rapier 单独 ${off.precession.toFixed(4)}），最大倾角 ${r.maxTilt.toFixed(3)}`);
    expect(Math.abs(r.precession - r.theory) / r.theory).toBeLessThan(0.1);
    expect(r.maxTilt).toBeLessThan(0.3);
  });

  it('T2 重陀螺：1.5 ω_c 时 3.5 s 内倾角 < 2 倍初值；0.6 ω_c 时倾角超过 1 rad（倒下）', () => {
    const hi = heavyTop(1.5);
    const lo = heavyTop(0.6);
    console.log(`[T2] 1.5 ω_c 最大倾角 ${hi.maxTilt.toFixed(3)}；0.6 ω_c 最大倾角 ${lo.maxTilt.toFixed(3)}`);
    expect(hi.maxTilt).toBeLessThan(0.4);
    expect(lo.maxTilt).toBeGreaterThan(1);
  });
});

describe('陀螺项：场地内（T3）', () => {
  let RAP: R;
  beforeAll(async () => {
    RAP = await loadRapier();
  });
  const ledgerSum = (l: SpinLedger) => Object.entries(l).reduce((a, [k, v]) => a + (k === 'contactGain' ? -v : v), 0);

  for (const sg of SIGNATURE_LIST) {
    it(`${sg.name}：陀螺项开、自稳 PD 关、牵引按实际倾斜，单台 10 s 无 NaN、账本残差 ≤ 1%、2 s 时没有倒下`, () => {
      Object.assign(GYRO_EXPERIMENT, { enabled: 1, pd: 0, tiltDrive: 1 });
      const rnd0 = Math.random;
      Math.random = seeded(20261111);
      try {
        const pw = new PhysicsWorld(RAP, { observeContacts: false });
        createArenaPhysics(pw);
        const spec = assembleBey(sg.loadout);
        const bey = new BeyPhysics(pw, spec, { ...computeLaunch(spec, 'player', { power: 0.8, aim: 0, tilt: 0 }), seed: 7 });
        pw.beforeStep = (dt) => bey.preStep(dt);
        let tilt2 = NaN;
        let maxSpeed = 0;
        for (let s = 1; s <= Math.round(10 / DT); s++) {
          pw.step();
          const p = bey.body.translation();
          const v = bey.body.linvel();
          expect(Number.isFinite(p.x + p.y + p.z + v.x + v.y + v.z)).toBe(true);
          maxSpeed = Math.max(maxSpeed, Math.hypot(v.x, v.z));
          if (s === Math.round(2 / DT)) tilt2 = bey.tilt;
        }
        const resid = Math.abs(bey.launchSpin - bey.spin - ledgerSum(bey.ledger)) / bey.launchSpin;
        console.log(`[T3] ${sg.key}：2 s 倾角 ${tilt2.toFixed(3)}，10 s 转速 ${bey.spin.toFixed(1)} / ${bey.launchSpin.toFixed(1)}，最大水平速度 ${maxSpeed.toFixed(2)}，账本残差 ${resid.toExponential(2)}`);
        expect(resid).toBeLessThan(0.01);
        expect(tilt2).toBeLessThan(1.1);
        expect(maxSpeed).toBeLessThan(25);
        pw.dispose();
      } finally {
        Math.random = rnd0;
      }
    });
  }

  it('默认关闭：开关是现有行为（与 golden 同一条路径）', () => {
    expect(GYRO_EXPERIMENT).toEqual({ enabled: 0, pd: 1, tiltDrive: 0 });
  });
});
