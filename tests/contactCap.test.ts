import { afterEach, describe, expect, it } from 'vitest';
import { floorHeight } from '../src/game/arena/arenaSpec';
import { createArenaPhysics } from '../src/game/arena/ArenaPhysics';
import { BeyPhysics } from '../src/game/beys/BeyPhysics';
import { assembleBey } from '../src/game/beys/parts/assemble';
import { SIGNATURE_LIST } from '../src/game/beys/parts/catalog';
import { capHullPoints, FLAT_TIP, GYRO_EXPERIMENT } from '../src/game/physics/gyro';
import { loadRapier, PhysicsWorld, PHYSICS_DT } from '../src/game/physics/PhysicsWorld';

/**
 * M4 最后一轮 C1 的接触几何（docs/engineering/m4-final-round-plan.md §1）：
 *  - 开关默认关闭（flatTip = 0），默认行为由 golden 保证不变；
 *  - 球冠点集：倒圆后最低点在轴心原点，球面部分半径 = capRadius，边缘半径 = contactRadius；
 *  - Rapier 刚体的质量与主惯量和 massProps 的解析值（按同尺寸圆柱）相差 < 3%；
 *  - 静稳定方向：不转、倾斜 0.15 rad 释放——圆角圆柱平底（倒圆 0.05）立回去，球冠 ρ = 0.25（< 重心高度）倒下。
 */
const gy0 = { ...GYRO_EXPERIMENT };
const ft0 = { ...FLAT_TIP };
afterEach(() => {
  Object.assign(GYRO_EXPERIMENT, gy0);
  Object.assign(FLAT_TIP, ft0);
});

const lieren = SIGNATURE_LIST.find((s) => s.key === 'lieren')!;

describe('C1 微凸球冠接地', () => {
  it('开关默认关闭', () => {
    expect(GYRO_EXPERIMENT.flatTip).toBe(0);
  });

  it('球冠点集：最低点在原点、球面半径 = capRadius、边缘半径 = contactRadius', () => {
    const tip = { ...FLAT_TIP, capRadius: 0.25 };
    const a = 0.15;
    const pts = capHullPoints(a, tip);
    let minY = Infinity;
    let maxR = 0;
    for (let i = 0; i < pts.length; i += 3) {
      const [x, y, z] = [pts[i], pts[i + 1], pts[i + 2]];
      minY = Math.min(minY, y);
      maxR = Math.max(maxR, Math.hypot(x, z));
      // 球面部分（低于边缘高度）的点到球心 (0, ρ, 0) 的距离 = ρ − 倒圆
      const yEdge = tip.capRadius - (tip.capRadius - tip.capBorder) * Math.cos(Math.asin((a - tip.capBorder) / (tip.capRadius - tip.capBorder)));
      if (y <= yEdge + 1e-6) expect(Math.hypot(x, y - tip.capRadius, z)).toBeCloseTo(tip.capRadius - tip.capBorder, 5);
    }
    // 外扩倒圆后：最低点 = 0，最大半径 = contactRadius
    expect(minY - tip.capBorder).toBeCloseTo(0, 6);
    expect(maxR + tip.capBorder).toBeCloseTo(a, 5);
  });

  it('球冠与圆角圆柱的 Rapier 质量、主惯量（排序后逐个比较）相差 < 3%（质量属性沿用同尺寸圆柱的依据）', async () => {
    const R = await loadRapier();
    const props = (flatTip: number) => {
      Object.assign(GYRO_EXPERIMENT, { flatTip });
      FLAT_TIP.border = 0.05;
      FLAT_TIP.capRadius = 0.25;
      const pw = new PhysicsWorld(R);
      const bey = new BeyPhysics(pw, assembleBey(lieren.loadout), { ...computeLaunchLike(), seed: 1 });
      const I = bey.body.principalInertia();
      const out = { m: bey.body.mass(), I: [I.x, I.y, I.z].sort((a, b) => a - b), comY: bey.body.localCom().y };
      pw.dispose();
      return out;
    };
    const cyl = props(1);
    const cap = props(2);
    expect(Math.abs(cap.m - cyl.m) / cyl.m).toBeLessThan(0.03);
    for (let i = 0; i < 3; i++) expect(Math.abs(cap.I[i] - cyl.I[i]) / cyl.I[i]).toBeLessThan(0.03);
    expect(Math.abs(cap.comY - cyl.comY)).toBeLessThan(0.02);
  });

  it('静稳定方向：圆角圆柱倾斜 0.15 rad 立回去，球冠 ρ = 0.25 倒下（不转）', async () => {
    const R = await loadRapier();
    const stand = (flatTip: number) => {
      Object.assign(GYRO_EXPERIMENT, { enabled: 1, pd: 0, tiltDrive: 1, explicitDrive: 0, scrape: 0, flatTip });
      FLAT_TIP.border = 0.05;
      FLAT_TIP.capRadius = 0.25;
      const pw = new PhysicsWorld(R);
      createArenaPhysics(pw);
      const spec = assembleBey(lieren.loadout);
      const bey = new BeyPhysics(pw, spec, {
        position: { x: 0, y: floorHeight(0) + spec.bit.contactRadius * Math.sin(0.15) + 0.01, z: 0 },
        velocity: { x: 0, y: 0, z: 0 },
        spin: 0,
        tilt: 0.15,
        tiltAxis: { x: 1, y: 0, z: 0 },
        seed: 1,
      });
      pw.beforeStep = (dt) => bey.preStep(dt);
      for (let i = 0; i < Math.round(3 / PHYSICS_DT); i++) pw.step();
      const t = bey.tilt;
      pw.dispose();
      return t;
    };
    expect(stand(1)).toBeLessThan(0.05);
    expect(stand(2)).toBeGreaterThan(0.6);
  });
});

/** 静止的发射参数（只用于构造陀螺读质量属性） */
function computeLaunchLike() {
  return { position: { x: 0, y: 5, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, spin: 100, tilt: 0, tiltAxis: { x: 1, y: 0, z: 0 } };
}
