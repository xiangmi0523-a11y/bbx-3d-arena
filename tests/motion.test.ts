import { describe, expect, it } from 'vitest';
import { createArenaPhysics } from '../src/game/arena/ArenaPhysics';
import { BattleSystem, isDeathWobble } from '../src/game/battle/BattleSystem';
import { BEY_TUNING } from '../src/game/beys/BeyPhysics';
import { INTENT_TUNING, MotionIntent, profileOf } from '../src/game/beys/motionIntent';
import { assembleBey } from '../src/game/beys/parts/assemble';
import { loadRapier, PhysicsWorld, PHYSICS_DT } from '../src/game/physics/PhysicsWorld';
import { runMotion, seeded, type MotionRun } from './motion/motionSim';
import { ATK, BAL, DEF, DEF_PLAYER, DEF_RIVAL, groups, STA } from './motion/scenarios';

/**
 * 自主运动重构的回归测试（固定种子、真实物理）。
 * 基线 0dac2ad 的对照数字来自 tests/diag/motion.diag.ts 在基线工作树里的同一套场景（见报告）。
 */
const group = (key: string, n = 8) => groups().find((g) => g.key === key)!.scenarios.slice(0, n);
const runAll = async (key: string, n = 8) => {
  const out: MotionRun[] = [];
  for (const sc of group(key, n)) out.push(await runMotion(sc));
  return out;
};
const avg = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);

async function battleWorld(seed: number, lo = { player: DEF_PLAYER, rival: DEF_RIVAL }) {
  const R = await loadRapier();
  const pw = new PhysicsWorld(R);
  createArenaPhysics(pw);
  const orig = Math.random;
  Math.random = seeded(seed);
  const b = new BattleSystem(pw, { player: assembleBey(lo.player), rival: assembleBey(lo.rival) });
  pw.beforeStep = (dt) => b.preStep(dt);
  pw.afterStep = (dt) => b.postStep(dt);
  b.launch('player', { power: 0.8, aim: 0.2, tilt: 0 });
  b.launch('rival', { power: 0.8, aim: -0.2, tilt: 0 });
  Math.random = orig;
  return { pw, b };
}

describe('战术意图层（纯逻辑）', () => {
  it('调制深度永远 < 1（进动相位不会被锁死），且只由配件属性推出运动倾向', () => {
    const rnd = seeded(7);
    for (const lo of [ATK, DEF, STA, BAL]) {
      const it = new MotionIntent(assembleBey(lo), 42);
      for (let i = 0; i < 4000; i++) {
        it.update({
          dt: PHYSICS_DT,
          px: (rnd() - 0.5) * 8,
          pz: (rnd() - 0.5) * 8,
          vx: (rnd() - 0.5) * 8,
          vz: (rnd() - 0.5) * 8,
          ox: (rnd() - 0.5) * 8,
          oz: (rnd() - 0.5) * 8,
          ovx: (rnd() - 0.5) * 6,
          ovz: (rnd() - 0.5) * 6,
          bladeSum: 1,
          outerSum: 1,
          spinRatio: rnd(),
          oppSpinRatio: rnd(),
          oppAggression: rnd(),
        });
        expect(it.authority).toBeGreaterThanOrEqual(0);
        expect(it.authority).toBeLessThanOrEqual(INTENT_TUNING.authorityCap);
        expect(Number.isFinite(it.heading)).toBe(true);
      }
    }
    expect(INTENT_TUNING.authorityCap).toBeLessThan(1);
    const pa = profileOf(assembleBey(ATK));
    const pd = profileOf(assembleBey(DEF));
    const ps = profileOf(assembleBey(STA));
    expect(pa.aggression).toBeGreaterThan(0.6);
    expect(pd.aggression).toBeLessThan(0.1);
    expect(pd.steadiness).toBeGreaterThan(pa.steadiness);
    expect(ps.economy).toBeGreaterThan(0.9);
    expect(pd.economy).toBeLessThan(0.3);
  });

  it('同一种子决策序列完全相同，不同种子不同（确定性随机，不用 Math.random）', () => {
    const seq = (seed: number) => {
      const it = new MotionIntent(assembleBey(ATK), seed);
      const out: string[] = [];
      for (let i = 0; i < 2400; i++) {
        const t = i * PHYSICS_DT;
        it.update({ dt: PHYSICS_DT, px: Math.cos(t) * 2, pz: Math.sin(t) * 2, vx: -Math.sin(t) * 2, vz: Math.cos(t) * 2, ox: 0, oz: 0, ovx: 0, ovz: 0, bladeSum: 1, outerSum: 1, spinRatio: 0.8, oppSpinRatio: 0.8, oppAggression: 0 });
        out.push(`${it.state}:${it.heading.toFixed(4)}`);
      }
      return out.join('|');
    };
    expect(seq(5)).toBe(seq(5));
    expect(seq(5)).not.toBe(seq(6));
  });
});

describe('自主运动：物理约束（真实物理，固定种子）', () => {
  it('整场对战可复现：同种子逐步相同，不同种子不同', async () => {
    const trace = async (seed: number) => {
      const { pw, b } = await battleWorld(seed);
      let s = '';
      for (let i = 0; i < 120 * 8 && !b.result; i++) {
        pw.step();
        if (i % 30 === 0) {
          const p = b.beys.player!.body.translation();
          s += `${p.x.toFixed(5)},${p.z.toFixed(5)};`;
        }
      }
      pw.dispose();
      return s;
    };
    expect(await trace(11)).toBe(await trace(11));
    expect(await trace(11)).not.toBe(await trace(12));
  });

  it('不改位置、不覆盖速度：发射后陀螺自身只施加有上限的冲量（牵引 / 轨道冲刺 / 滚动阻力），从不直接设置速度或位置', async () => {
    const { pw, b } = await battleWorld(21, { player: ATK, rival: DEF });
    let setCalls = 0;
    let worst = 0;
    let impulses = 0;
    for (const x of [b.beys.player!, b.beys.rival!]) {
      const body = x.body as unknown as Record<string, (...a: unknown[]) => unknown>;
      for (const m of ['setLinvel', 'setTranslation', 'setNextKinematicTranslation']) {
        const o = body[m].bind(body);
        body[m] = (...a: unknown[]) => {
          setCalls++;
          return o(...a);
        };
      }
      const oi = body.applyImpulse.bind(body);
      body.applyImpulse = (imp: unknown, wake: unknown) => {
        const v = imp as { x: number; y: number; z: number };
        // 冲量 / (质量 × dt) = 加速度。牵引上限 driveAccel × 咬合度(≤1)，轨道冲刺 railDash × 咬合度，滚动阻力 < 1
        worst = Math.max(worst, Math.hypot(v.x, v.y, v.z) / (x.body.mass() * PHYSICS_DT));
        impulses++;
        return oi(imp, wake);
      };
    }
    for (let i = 0; i < 120 * 20 && !b.result; i++) pw.step();
    pw.dispose();
    expect(setCalls).toBe(0);
    expect(impulses).toBeGreaterThan(1000);
    expect(worst).toBeLessThanOrEqual(Math.max(BEY_TUNING.driveAccel, BEY_TUNING.railDash) + 1e-6);
  }, 60000);

  it('进动相位始终沿自然方向转动：调制后的转速不低于自然转速的 (1 − 调制上限)，不会锁定在对手方向', async () => {
    const { pw, b } = await battleWorld(31, { player: ATK, rival: DEF });
    const A = b.beys.player!;
    const get = () => (A as unknown as { precession: number }).precession;
    let minRatio = Infinity;
    let n = 0;
    for (let i = 0; i < 120 * 15 && !b.result; i++) {
      const ph0 = get();
      const mag = A.spin;
      pw.step();
      // 跳过“被撞歪后相位跟随实际倾斜”的步（那是物理姿态决定的）与失稳阶段
      if (A.knocked || A.tilt > 0.5 || mag < BEY_TUNING.minStableSpin * 2) continue;
      const nat = A.spinDirection * -(BEY_TUNING.precessBase + BEY_TUNING.precessSpin / Math.max(20, mag));
      const ratio = (get() - ph0) / PHYSICS_DT / nat;
      if (Math.abs(ratio) > 1e-9) {
        minRatio = Math.min(minRatio, ratio);
        n++;
      }
    }
    pw.dispose();
    expect(n).toBeGreaterThan(300);
    expect(minRatio).toBeGreaterThan(1 - INTENT_TUNING.authorityCap - 0.02);
  }, 60000);

  it('能量：战术意图不产生能量——系统总能量（平动 + 自转 + 势能）不会超过发射后的值', async () => {
    for (const key of ['AvD', 'BvB', 'SvA']) {
      for (const r of await runAll(key, 4)) expect(r.energyMaxRatio, `${key} ${r.name}`).toBeLessThan(1.01);
    }
  }, 120000);
});

describe('自主运动：行为（固定种子，与基线 0dac2ad 对照）', () => {
  it('不再是“冲撞—固定角度后退—再冲撞”的循环：没有回弹 / 助跑状态，攻击型加速度锁定对手的时间低于基线', async () => {
    const rs = await runAll('AvD', 8);
    for (const r of rs) {
      expect(Object.keys(r.p.states)).not.toContain('recoil');
      expect(Object.keys(r.p.states)).not.toContain('charge');
    }
    // 基线（同 8 场）：攻击型加速度方向锁定对手（cos > 0.8）约 58%，防御型 42%
    expect(avg(rs.map((r) => r.p.accelLock))).toBeLessThan(0.52);
    expect(avg(rs.map((r) => r.r.accelLock))).toBeLessThan(0.4);
  }, 120000);

  it('类型差异来自配件：攻击型切入、防御型守中不追击、耐力型游走 / 闪避', async () => {
    const avd = await runAll('AvD', 8);
    const sva = await runAll('SvA', 8);
    const st = (rs: MotionRun[], side: 'p' | 'r', k: string) => avg(rs.map((r) => r[side].states[k] ?? 0));
    expect(st(avd, 'p', 'cut')).toBeGreaterThan(0.25);
    expect(st(avd, 'r', 'cut')).toBe(0);
    expect(st(avd, 'r', 'guard')).toBeGreaterThan(0.25);
    expect(st(sva, 'p', 'cut')).toBe(0);
    expect(st(sva, 'p', 'roam') + st(sva, 'p', 'evade')).toBeGreaterThan(0.25);
    // 防御型待在中央附近，攻击型跑得更开
    expect(avg(avd.map((r) => r.r.meanR))).toBeLessThan(avg(avd.map((r) => r.p.meanR)));
    // 耐力型移动最少
    expect(avg(sva.map((r) => r.p.meanSpeed))).toBeLessThan(avg(sva.map((r) => r.r.meanSpeed)) * 0.6);
  }, 120000);

  it('碰撞会改变后续轨迹：接触前后运动方向平均变化 > 70°（基线约 70–90°）', async () => {
    const rs = [...(await runAll('AvD', 6)), ...(await runAll('BvB', 6))];
    expect(avg(rs.map((r) => r.postTurn).filter(Number.isFinite))).toBeGreaterThan(70);
  }, 120000);

  it('仍有足够交锋：默认组合接触 ≥ 3 次 / 10 秒、中等以上撞击 ≥ 2 次 / 10 秒，没有超过 12 秒不接触', async () => {
    const rs = await runAll('DFLT', 8);
    const dur = sum(rs.map((r) => r.duration));
    // 基线：接触 5.5、中等以上 4.7（其中约 12% 是没拉开就再撞的“顶牛”）
    expect((sum(rs.map((r) => r.contacts)) / dur) * 10).toBeGreaterThan(3);
    expect((sum(rs.map((r) => r.strong)) / dur) * 10).toBeGreaterThan(2);
    expect(Math.max(...rs.map((r) => r.longestGap))).toBeLessThan(12);
  }, 120000);

  it('边缘：意图不会把陀螺带去贴墙——攻击 / 防御对局撞墙 < 1 次 / 10 秒，贴边 < 4%', async () => {
    const rs = [...(await runAll('AvD', 8)), ...(await runAll('DvA', 8))];
    expect(avg(rs.map((r) => r.wall10))).toBeLessThan(1);
    expect(avg(rs.flatMap((r) => [r.p.edgeFrac, r.r.edgeFrac]))).toBeLessThan(0.04);
  }, 120000);
});

describe('自主运动第二轮修正（固定种子）', () => {
  it('死亡摇摆判定不会误判高转速摩擦：只有「低转速 + 明显倾斜 + 持续贴靠 + 对方明显更健康」同时满足才算', () => {
    const T = BEY_TUNING;
    const base = { touching: true, lowSpin: 0.15, lowTiltExcess: 0.35, highSpin: 0.4, highCanDrive: true, highInBreakout: false };
    expect(isDeathWobble(base)).toBe(true);
    // 高转速贴身摩擦（哪怕撞歪、倾斜很大）
    for (const lowSpin of [0.3, 0.5, 0.8]) expect(isDeathWobble({ ...base, lowSpin, highSpin: Math.min(1, lowSpin + 0.2) })).toBe(false);
    // 低转速但轴基本竖直（正常的低速互磨，不是摇摆）
    expect(isDeathWobble({ ...base, lowTiltExcess: T.wobbleTilt - 0.01 })).toBe(false);
    // 双方一样虚弱（谁也没有余力脱离）
    expect(isDeathWobble({ ...base, highSpin: base.lowSpin + T.wobbleMargin / 2 })).toBe(false);
    // 没贴着 / 对方已经在脱困 / 对方没有牵引能力
    expect(isDeathWobble({ ...base, touching: false })).toBe(false);
    expect(isDeathWobble({ ...base, highInBreakout: true })).toBe(false);
    expect(isDeathWobble({ ...base, highCanDrive: false })).toBe(false);
  });

  it('发射初相：进攻型的初始牵引方向在发射方向 ±launchBias 内；防御 / 耐力刀刃保持随机初相', async () => {
    const R = await loadRapier();
    for (const [lo, aligned] of [
      [{ player: ATK, rival: DEF }, [true, false]],
      [{ player: STA, rival: BAL }, [false, true]],
    ] as const) {
      const pw = new PhysicsWorld(R);
      createArenaPhysics(pw);
      const orig = Math.random;
      Math.random = seeded(5);
      const b = new BattleSystem(pw, { player: assembleBey(lo.player), rival: assembleBey(lo.rival) });
      const beys = [b.launch('player', { power: 1, aim: 1, tilt: 0 })];
      const p0 = (beys[0] as unknown as { precession: number }).precession;
      beys.push(b.launch('rival', { power: 0.8, aim: -0.6, tilt: 0 }));
      Math.random = orig;
      beys.forEach((x, i) => {
        const prec = (x as unknown as { precession: number }).precession;
        const v = x.body.linvel();
        const drive = prec + (x.spinDirection * Math.PI) / 2;
        const rate0 = x.spinDirection * -(BEY_TUNING.precessBase + BEY_TUNING.precessSpin / Math.max(20, x.spin));
        // 初相 = 发射方向 + 偏置（≤ launchBias）− 自然进动 × launchPre / 2
        const off = Math.atan2(Math.sin(drive + (rate0 * BEY_TUNING.launchPre) / 2 - Math.atan2(v.z, v.x)), Math.cos(drive + (rate0 * BEY_TUNING.launchPre) / 2 - Math.atan2(v.z, v.x)));
        if (aligned[i]) expect(Math.abs(off)).toBeLessThanOrEqual(BEY_TUNING.launchBias + 1e-6);
        else if (i === 0) expect(prec).toBe(p0);
      });
      pw.dispose();
    }
  }, 60000);
});
