/// <reference types="node" />
/**
 * M4-A 基准（docs/engineering/m4-experiment-plan.md §1）：当前版本，不改任何游戏代码与参数，测量陀螺的完整生命周期。
 * 口径全部在 tests/diag/m4.metrics.ts。输出行首 M4A-：
 *  THEORY  质量属性与陀螺临界转速（刚体公式推算）【推断】
 *  PROBE   引擎探针：Rapier 是否积分陀螺力矩（无重力自由刚体）；去掉自稳 PD 后陀螺能否立住（探针里临时改参数并恢复）【模拟实测】
 *  SOLO    单台在场地里转到停（无对手、无战术意图）【模拟实测】
 *  MATRIX  签名矩阵 4×4×20（seed 20000+…，与 M5b base 臂同一批种子：终结计数必须与 M5b 记录一致，证明记录不改变结果）【模拟实测】
 *  BITS    同一刀刃 / 棘轮（疾风新月 + 六齿棘轮）换四种轴心，对磐盾、烈刃各 12 个种子【模拟实测】
 *
 * 用法：npx vitest run --config vitest.diag.config.ts tests/diag/m4a-baseline.diag.ts
 */
import { test } from 'vitest';
import { floorHeight } from '../../src/game/arena/arenaSpec';
import { createArenaPhysics } from '../../src/game/arena/ArenaPhysics';
import { FINISH_TUNING } from '../../src/game/battle/BattleSystem';
import { BEY_TUNING, BeyPhysics } from '../../src/game/beys/BeyPhysics';
import { beyMassProps } from '../../src/game/beys/massProps';
import { assembleBey, REF_INERTIA } from '../../src/game/beys/parts/assemble';
import { BITS, SIGNATURE_LIST, SIGNATURES, type SignatureKey } from '../../src/game/beys/parts/catalog';
import type { BeyLoadout } from '../../src/game/beys/parts/types';
import { rivalCommand } from '../../src/game/launcher/launch';
import { GRAVITY, loadRapier, PhysicsWorld, PHYSICS_DT } from '../../src/game/physics/PhysicsWorld';
import { seeded } from '../motion/motionSim';
import { beyByKey, median, phaseByKey, q, r2, r3, steps, summarizeProcess } from './m4.metrics';
import { M5B_BASE_COUNTS, PAIRS, POW, runSet, soloSuite, type Example, type R } from './m4.runs';
import { matrixScenarios, out, summarize } from './m5b.shared';
import type { Scn } from './stallprobe2.shared';

const DT = PHYSICS_DT;

function upOf(q: { x: number; y: number; z: number; w: number }) {
  return { x: 2 * (q.x * q.y - q.w * q.z), y: 1 - 2 * (q.x * q.x + q.z * q.z), z: 2 * (q.y * q.z + q.w * q.x) };
}

// ───────────────────────────── THEORY ─────────────────────────────

/** 当前模型的自稳强度倍率（与 BeyPhysics 构造函数同一公式） */
function gyroFactorOf(l: BeyLoadout): number {
  const spec = assembleBey(l);
  const k = BEY_TUNING.tipStability;
  return Math.sqrt(spec.spinInertia / REF_INERTIA) * (1 - k + k * Math.min(1.3, spec.bit.contactRadius / 0.12));
}

function theoryRows() {
  const g = -GRAVITY;
  const T = BEY_TUNING;
  const rows: Record<string, unknown>[] = [];
  const add = (name: string, l: BeyLoadout) => {
    const spec = assembleBey(l);
    const mp = beyMassProps(spec);
    // 圆头接地：重力对接触点的力臂 = 质心到接地球心的距离；横轴惯量按接地球心为支点（平行轴定理）
    const lever = mp.comY - spec.bit.contactRadius;
    const itPivot = mp.It + mp.mass * lever * lever;
    // 对称陀螺“睡眠”稳定条件：ω > ω_c = √(4 m g l I_t') / I_a（支点固定、无摩擦的经典结果）
    const wc = Math.sqrt(4 * mp.mass * g * lever * itPivot) / mp.Ia;
    const launch = (p: number) => spec.maxSpin * (0.4 + 0.6 * p);
    // 稳定进动（快速陀螺近似）：Ω = m g l / (I_a ω)
    const slowPrec = (w: number) => (mp.mass * g * lever) / (mp.Ia * w);
    rows.push({
      name,
      bit: l.bit,
      mass: r3(mp.mass),
      comY: r3(mp.comY),
      lever: r3(lever),
      Ia: r3(mp.Ia),
      It: r3(mp.It),
      ItPivot: r3(itPivot),
      wCrit: r2(wc),
      launch: [r2(launch(0.65)), r2(launch(0.8)), r2(launch(0.95))],
      critRatioAt08: r3(wc / launch(0.8)),
      physPrecessionAtLaunch08: r3(slowPrec(launch(0.8))),
      physPrecessionAt2wc: r3(slowPrec(2 * wc)),
      // 当前模型（BeyPhysics.preStep）的对应量
      modelPrecessionAtLaunch08: r3(T.precessBase + T.precessSpin / launch(0.8)),
      modelPrecessionAt2wc: r3(T.precessBase + T.precessSpin / Math.max(20, 2 * wc)),
      gyroFactor: r3(gyroFactorOf(l)),
      modelBands: {
        minStableRatio: r3(T.minStableSpin / launch(0.8)),
        gyroRampEndRatio: r3((T.minStableSpin + 0.3 * launch(0.8)) / launch(0.8)),
        leanShrinkBelowRatio: 0.5,
        driveOffBelowRatio: r3((2 * T.minStableSpin) / launch(0.8)),
        toppleSpinRatio: r3(FINISH_TUNING.toppleSpin / launch(0.8)),
      },
    });
  };
  SIGNATURE_LIST.forEach((s) => add(s.key, s.loadout));
  for (const bit of Object.keys(BITS)) add(`衡+${bit}`, { blade: 'gale-crescent', ratchet: 'hex-lock', bit });
  return { g, rows };
}

// ───────────────────────────── PROBE ─────────────────────────────

/** G1：无重力、无接触的自由刚体（圆盘），初始角速度偏离对称轴；角动量守恒 ⇔ 积分了陀螺项 ω × Iω */
function probeGyro(R: R) {
  const world = new R.World({ x: 0, y: 0, z: 0 });
  world.timestep = DT;
  const m = 3;
  const rad = 0.5;
  const hh = 0.1;
  const body = world.createRigidBody(R.RigidBodyDesc.dynamic().setCanSleep(false).setLinearDamping(0).setAngularDamping(0));
  world.createCollider(R.ColliderDesc.cylinder(hh, rad).setMass(m), body);
  const Ia = (m * rad * rad) / 2;
  const It = (m * (3 * rad * rad + 4 * hh * hh)) / 12;
  const w0 = { x: 4, y: 100, z: 0 };
  body.setAngvel(w0, true);
  const L = () => {
    const u = upOf(body.rotation());
    const w = body.angvel();
    const ws = w.x * u.x + w.y * u.y + w.z * u.z;
    return { x: It * w.x + (Ia - It) * ws * u.x, y: It * w.y + (Ia - It) * ws * u.y, z: It * w.z + (Ia - It) * ws * u.z };
  };
  // 第一步之前 Rapier 还没算质量属性：先走一步再取初值
  world.step();
  body.setAngvel(w0, true);
  const L0 = L();
  const n0 = Math.hypot(L0.x, L0.y, L0.z);
  let dL = 0;
  let dW = 0;
  let axisSwing = 0;
  for (let s = 0; s < 240; s++) {
    world.step();
    const l = L();
    const w = body.angvel();
    const u = upOf(body.rotation());
    dL = Math.max(dL, Math.hypot(l.x - L0.x, l.y - L0.y, l.z - L0.z) / n0);
    dW = Math.max(dW, Math.hypot(w.x - w0.x, w.y - w0.y, w.z - w0.z) / Math.hypot(w0.x, w0.y, w0.z));
    axisSwing = Math.max(axisSwing, Math.acos(Math.max(-1, Math.min(1, u.y))));
  }
  world.free();
  const verdict = dL < 0.01 ? 'Rapier 积分了陀螺项（自由转动角动量守恒）' : dW < 1e-4 ? 'Rapier 没有积分陀螺项（世界系角速度不变、角动量不守恒）' : '两者都不守恒（需要进一步检查）';
  return { Ia: r3(Ia), It: r3(It), w0, maxRelDriftL: r3(dL), maxRelDriftOmega: r3(dW), maxAxisSwingRad: r3(axisSwing), verdict };
}

/** G2：单台放在中央平台、初始倾斜 0.25 rad、静止、发射转速（力度 0.8）；默认自稳 vs 自稳 PD 去掉（uprightStiffness = uprightDamping = 0） */
function probeStand(R: R, key: SignatureKey, noPD: boolean) {
  const old = { k: BEY_TUNING.uprightStiffness, d: BEY_TUNING.uprightDamping };
  const rnd0 = Math.random;
  Math.random = seeded(4242);
  if (noPD) {
    BEY_TUNING.uprightStiffness = 0;
    BEY_TUNING.uprightDamping = 0;
  }
  try {
    const pw = new PhysicsWorld(R, { observeContacts: false });
    createArenaPhysics(pw);
    const spec = assembleBey(SIGNATURES[key].loadout);
    const spin = spec.maxSpin * (0.4 + 0.6 * 0.8);
    const bey = new BeyPhysics(pw, spec, { position: { x: 0, y: floorHeight(0) + 0.01, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, spin, tilt: 0.25, tiltAxis: { x: 1, y: 0, z: 0 }, seed: 7 });
    pw.beforeStep = (dt) => bey.preStep(dt);
    const marks = [0.1, 0.25, 0.5, 1, 2, 4];
    const rows: { t: number; tilt: number; spin: number; azSwept: number; r: number }[] = [];
    let az = Math.atan2(bey.up().z, bey.up().x);
    let swept = 0;
    let toppledAt: number | null = null;
    for (let s = 1; s <= steps(4); s++) {
      pw.step();
      const u = bey.up();
      const a = Math.atan2(u.z, u.x);
      swept += Math.abs(Math.atan2(Math.sin(a - az), Math.cos(a - az)));
      az = a;
      const tilt = Math.acos(Math.max(-1, Math.min(1, u.y)));
      if (toppledAt === null && tilt > FINISH_TUNING.toppleTilt) toppledAt = r3(s * DT);
      if (marks.some((m) => Math.abs(m - s * DT) < DT / 2)) {
        const p = bey.body.translation();
        rows.push({ t: r2(s * DT), tilt: r3(tilt), spin: r2(bey.spin), azSwept: r2(swept), r: r3(Math.hypot(p.x, p.z)) });
      }
    }
    pw.dispose();
    return { key, variant: noPD ? '去掉自稳 PD' : '默认', toppledAt, rows };
  } finally {
    BEY_TUNING.uprightStiffness = old.k;
    BEY_TUNING.uprightDamping = old.d;
    Math.random = rnd0;
  }
}

test('M4-A：理论推算 + 引擎探针', async () => {
  const R = await loadRapier();
  out('M4A-THEORY', theoryRows());
  out('M4A-PROBE-G1', probeGyro(R));
  for (const key of ['lieren', 'pandun', 'ziyao'] as SignatureKey[]) {
    out('M4A-PROBE-G2', probeStand(R, key, false));
    out('M4A-PROBE-G2', probeStand(R, key, true));
  }
});

test('M4-A：单台生命周期（无对手）', async () => {
  const R = await loadRapier();
  const res = soloSuite(R);
  for (const x of res.recs) out('M4A-SOLO-RUN', x);
  out('M4A-SOLO', { ms: res.ms, byName: res.byName });
});

test('M4-A：签名矩阵 4×4×20（终结过程、接触、恢复、战术与能量基线）', async () => {
  const R = await loadRapier();
  const examples: Example[] = [];
  const res = runSet(R, matrixScenarios(20000, 20), 'matrix', examples);
  const sum = summarize(res.recs);
  const same = JSON.stringify(sum.counts) === JSON.stringify(M5B_BASE_COUNTS);
  out('M4A-MATRIX-CHECK', { counts: sum.counts, m5bBase: M5B_BASE_COUNTS, identical: same, ms: res.ms });
  out('M4A-MATRIX-SUMMARY', { ...sum, tactics: res.tactics });
  out('M4A-MATRIX-PROCESS', summarizeProcess(res.metrics));
  const byPair: Record<string, unknown> = {};
  for (const [tag, x, y] of PAIRS) byPair[tag] = summarizeProcess(res.metrics.filter((m) => (m.keys[0] === x && m.keys[1] === y) || (m.keys[0] === y && m.keys[1] === x)));
  out('M4A-MATRIX-PROCESS-PAIRS', byPair);
  out('M4A-MATRIX-PHASE', phaseByKey(res.metrics.filter((m) => m.keys[0] !== m.keys[1])));
  out('M4A-MATRIX-BEY', beyByKey(res.metrics.filter((m) => m.keys[0] !== m.keys[1])));
  out('M4A-MATRIX-CURVES', res.curves);
  const durs = res.metrics.map((m) => m.dur);
  out('M4A-MATRIX-DURATION', { p10: r2(q(durs, 0.1)), p50: r2(median(durs)), p90: r2(q(durs, 0.9)), under10s: r3(durs.filter((d) => d < 10).length / durs.length), atLimit: r3(durs.filter((d) => d >= 60).length / durs.length) });
  for (const e of examples) out('M4A-MATRIX-EXAMPLE', e);
});

test('M4-A：轴心变体（疾风新月 + 六齿棘轮 × 四种轴心，对磐盾 / 烈刃）', async () => {
  const R = await loadRapier();
  const bits = Object.keys(BITS);
  const opps = [SIGNATURES.pandun, SIGNATURES.lieren];
  const scs: Scn[] = [];
  bits.forEach((bit, bi) =>
    opps.forEach((op, oi) => {
      for (let i = 0; i < 12; i++) {
        const seed = 70000 + bi * 1000 + oi * 100 + i;
        const rnd = seeded(seed * 7 + 13);
        scs.push({ name: `${bit.replace('-', '')}-${op.key}#${i}`, group: 'BITS', player: { blade: 'gale-crescent', ratchet: 'hex-lock', bit }, rival: op.loadout, pCmd: { power: POW[i % 3], aim: (rnd() - 0.5) * 1.2, tilt: 0 }, rCmd: rivalCommand(rnd), seed, maxSeconds: 61, init: '轴心变体' });
      }
    }),
  );
  const res = runSet(R, scs, 'bits');
  const per: Record<string, unknown> = {};
  for (const bit of bits) {
    const k = bit.replace('-', '');
    for (const op of opps) {
      const rs = res.recs.filter((x) => x.p === k && x.r === op.key);
      const wins = rs.filter((x) => x.kind === 'win' && x.winner === 'player').length;
      const fin = rs.reduce<Record<string, number>>((a, x) => {
        const f = x.kind === 'win' ? `${x.winner === 'player' ? '胜' : '负'}:${x.finish}` : x.kind;
        a[f] = (a[f] ?? 0) + 1;
        return a;
      }, {});
      per[`${k} vs ${op.key}`] = { rounds: rs.length, winShare: r3(wins / rs.length), finishes: fin, durP50: r2(median(rs.map((x) => x.dur))) };
    }
  }
  out('M4A-BITS', { ms: res.ms, per, tactics: res.tactics });
  out('M4A-BITS-PROCESS', summarizeProcess(res.metrics));
  out('M4A-BITS-PHASE', phaseByKey(res.metrics));
  out('M4A-BITS-CURVES', res.curves);
});
