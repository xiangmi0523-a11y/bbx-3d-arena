import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { BEY_TUNING } from '../src/game/beys/BeyPhysics';
import { GRAVITY, loadRapier, PHYSICS_DT } from '../src/game/physics/PhysicsWorld';
import { seeded } from './motion/motionSim';
import { classifyPreStepImpulses, classifyWindow, closeLedger, instrument, isNN, newTrack, windowMetrics, withDriveMinGrip, type Ledger } from './diag/e1e2.shared';
import { fingerprint, scenariosV2, setup } from './diag/stallprobe2.shared';

/**
 * E1 / E2 诊断逻辑的边界：账本闭合与拆分、冲量归类、窗口指标、诊断覆盖的作用域，
 * 以及“插桩不改变物理”（逐步 hash 与 Stage A 固定种子基线一致）。
 */
type R = Awaited<ReturnType<typeof loadRapier>>;
let RAP: R;
beforeAll(async () => {
  RAP = await loadRapier();
});
const scn = (name: string) => scenariosV2().find((s) => s.name === name)!;
const Z = () => ({ x: 0, y: 0, z: 0 });

/** Stage A（2f573ab）固定种子逐步状态 hash：与 cb4c2c4 干净工作树的无插桩运行相同（Stage A 已证明 180/180 一致） */
const STAGE_A_HASH: Record<string, string> = {
  'CTRL center NN#0': '082951ef282a4373125de6b2770c7e72f33ceb13510d4097379f32062820185d',
  'BvB#4': 'd0d29f30d93d808fc9a8b271792c72c3110c584e9f90ee2308c03b77336800fd',
  'SvA#1': '6a4a4c9b50a64bca7e08b9a54af21744382e2b5dc1e404a975f7797f669a5578',
};

function run(name: string, opts: { instrumented: boolean; grip?: number | null }) {
  const sc = scn(name);
  const orig = Math.random;
  Math.random = seeded(sc.seed);
  try {
    return withDriveMinGrip(opts.grip ?? null, () => {
      const { pw, b, A, B } = setup(RAP, sc);
      const beys = [A, B] as [typeof A, typeof B];
      const ins = opts.instrumented ? instrument(RAP, pw, b, beys, true) : null;
      const h = createHash('sha256');
      const max = (sc.maxSeconds ?? 60) / PHYSICS_DT;
      const st = { trac: 0, unclassified: 0, tangent: 0, preErr: 0, postErr: 0, vert: [] as number[], nn: isNN(beys) };
      for (let s = 0; s < max && !b.result; s++) {
        pw.step();
        fingerprint(h, beys);
        if (ins)
          for (const L of ins.led) {
            if (L.tracOn) st.trac++;
            st.unclassified += L.unclassified;
            st.tangent = Math.max(st.tangent, L.tangentRead);
            st.preErr = Math.max(st.preErr, L.preErr);
            st.postErr = Math.max(st.postErr, L.postErr);
            if (L.kind === 'floor') st.vert.push(Math.abs(L.unexpl.y) / (-GRAVITY * PHYSICS_DT * L.m));
          }
      }
      pw.dispose();
      return { hash: h.digest('hex'), ...st };
    });
  } finally {
    Math.random = orig;
  }
}

describe('E1 / E2 诊断', () => {
  it('账本拆分：切平面内且在库仑锥内的残差记为摩擦，法向分量和超出锥的部分记为未解释', () => {
    const L = {
      m: 2, v0: Z(), v1: Z(), v2: Z(), v3: Z(), w1: Z(), trac: Z(), roll: Z(), dash: Z(), smash: Z(), unclassified: 0, tracOn: false,
      damp: Z(), nFloor: { x: 0, y: -GRAVITY * PHYSICS_DT * 2, z: 0 }, nStatic: Z(), nBey: Z(), lamFloor: -GRAVITY * PHYSICS_DT * 2, lamStatic: 0, lamBey: 0,
      cone: 0.06 * -GRAVITY * PHYSICS_DT * 2, floorN: { x: 0, y: 1, z: 0 }, floorP: Z(), tangentRead: 0, fric: Z(), unexpl: Z(), kind: 'none', slip: Z(), slipLin: Z(), slipSpin: Z(), slipPerp: Z(), preErr: 0, postErr: 0,
    } as Ledger;
    // 静止 + 水平摩擦 0.005 N·s（锥 0.02）：全部记为摩擦
    L.v2 = { x: 0.005 / 2, y: 0, z: 0 };
    closeLedger(L);
    expect(L.kind).toBe('floor');
    expect(L.fric.x).toBeCloseTo(0.005, 12);
    expect(Math.hypot(L.unexpl.x, L.unexpl.y, L.unexpl.z)).toBeLessThan(1e-12);
    // 超出锥：0.03 N·s → 摩擦 0.02，未解释 0.01
    L.v2 = { x: 0.03 / 2, y: 0, z: 0 };
    closeLedger(L);
    expect(L.fric.x).toBeCloseTo(L.cone, 9);
    expect(L.unexpl.x).toBeCloseTo(0.03 - L.cone, 9);
    // 法向多出 0.001 N·s：记为未解释（摩擦不可能有法向分量）
    L.v2 = { x: 0, y: 0.001 / 2, z: 0 };
    closeLedger(L);
    expect(L.unexpl.y).toBeCloseTo(0.001, 12);
    expect(Math.hypot(L.fric.x, L.fric.y, L.fric.z)).toBeLessThan(1e-12);
    // 无接触：全部未解释
    L.lamFloor = 0;
    L.nFloor = Z();
    L.cone = 0;
    L.v2 = { x: 0.01, y: GRAVITY * PHYSICS_DT, z: 0 };
    closeLedger(L);
    expect(L.kind).toBe('none');
    expect(L.unexpl.x).toBeCloseTo(0.02, 12);
  });

  it('游戏代码冲量归类：滚动阻力按 preStep 同式识别，冲刺 / 牵引按顺序识别', () => {
    const sc = scn('LONG S/S#0');
    const orig = Math.random;
    Math.random = seeded(sc.seed);
    const { pw, A } = setup(RAP, sc);
    Math.random = orig;
    const m = A.body.mass();
    const v = { x: 0.3, y: 0, z: -0.4 };
    const k = (BEY_TUNING.rollBase + BEY_TUNING.rollFriction * A.spec.tip.friction) * -GRAVITY * PHYSICS_DT;
    const roll = { x: (-0.3 / 0.5) * k * m, y: 0, z: (0.4 / 0.5) * k * m };
    const trac = { x: 0.01, y: 0, z: 0.02 };
    const c1 = classifyPreStepImpulses(A, [{ j: trac, v }, { j: roll, v }], false);
    expect(c1.tracOn).toBe(true);
    expect(c1.trac.x).toBe(0.01);
    expect(c1.roll.z).toBe(roll.z);
    expect(c1.unclassified).toBe(0);
    const c2 = classifyPreStepImpulses(A, [{ j: trac, v }, { j: roll, v }], true);
    expect(c2.tracOn).toBe(false);
    expect(c2.dash.x).toBe(0.01);
    const c3 = classifyPreStepImpulses(A, [{ j: { x: 1, y: 1, z: 1 }, v }], false);
    expect(c3.unclassified).toBe(1);
    pw.dispose();
  });

  it('窗口指标与分类：静止 → 停滞；小半径绕圈 → circling；直线朝对手 → towardOpponent', () => {
    const N = 1200;
    const mk = (f: (s: number) => [number, number, number]) => {
      const t = newTrack(N);
      for (let s = 0; s < N; s++) {
        const [x, z, sp] = f(s);
        t.px[0][s] = x;
        t.pz[0][s] = z;
        t.speed[0][s] = sp;
        t.px[1][s] = 3;
        t.pz[1][s] = 0;
      }
      return t;
    };
    expect(classifyWindow(windowMetrics(mk(() => [0, 0, 0.01]), 0, 0, N))).toBe('stalled');
    const circ = windowMetrics(mk((s) => [0.2 * Math.cos(s * PHYSICS_DT * 5), 0.2 * Math.sin(s * PHYSICS_DT * 5), 1]), 0, 0, N);
    expect(circ.gyration).toBeCloseTo(0.2, 2);
    expect(circ.path).toBeCloseTo(10, 1);
    expect(classifyWindow(circ)).toBe('circling');
    const line = windowMetrics(mk((s) => [(2.5 * s) / N, 0, 0.5]), 0, 0, N);
    expect(line.straightness).toBeCloseTo(1, 6);
    expect(line.approachCos).toBeCloseTo(1, 6);
    expect(classifyWindow(line)).toBe('towardOpponent');
  });

  it('诊断覆盖只在执行期间生效，抛错时也恢复', () => {
    expect(BEY_TUNING.driveMinGrip).toBe(0.2);
    expect(withDriveMinGrip(0.05, () => BEY_TUNING.driveMinGrip)).toBe(0.05);
    expect(BEY_TUNING.driveMinGrip).toBe(0.2);
    expect(() =>
      withDriveMinGrip(0.05, () => {
        throw new Error('x');
      }),
    ).toThrow('x');
    expect(BEY_TUNING.driveMinGrip).toBe(0.2);
  });

  it('固定种子回归：插桩运行的逐步 hash 与 Stage A 基线一致，账本闭合，摩擦读数恒为 0', () => {
    for (const name of Object.keys(STAGE_A_HASH)) {
      const r = run(name, { instrumented: true });
      expect(r.hash, name).toBe(STAGE_A_HASH[name]);
      expect(r.unclassified, name).toBe(0);
      expect(r.tangent, name).toBe(0);
      expect(r.preErr, name).toBeLessThan(1e-4);
      expect(r.postErr, name).toBeLessThan(1e-4);
      const v = r.vert.sort((a, b) => a - b);
      // 竖直残差 P50 / (g·dt)：验证法向冲量 × 8/9 的子步修正。8/9 是稳态近似（假设相邻步冲量相同），
      // 针尖对针尖低速（E1 的对象）< 1%；有攻击型的高动态对局实测约 1.3%，单独给 5% 的界并在报告中写明
      expect(v[Math.floor(v.length / 2)], name).toBeLessThan(scn(name).name.includes('NN') ? 0.01 : 0.05);
    }
  });

  it('E2 覆盖：针尖对针尖下牵引开始施加；覆盖结束后其他场次与基线逐步一致', () => {
    const a = run('CTRL center NN#0', { instrumented: true });
    const b = run('CTRL center NN#0', { instrumented: true, grip: 0.05 });
    expect(a.nn).toBe(true);
    expect(a.trac).toBe(0);
    expect(b.trac).toBeGreaterThan(0);
    expect(b.hash).not.toBe(a.hash);
    expect(BEY_TUNING.driveMinGrip).toBe(0.2);
    expect(run('SvA#1', { instrumented: false }).hash).toBe(STAGE_A_HASH['SvA#1']);
  });
});
