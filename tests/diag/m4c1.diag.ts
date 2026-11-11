/// <reference types="node" />
/**
 * M4 最后一轮 第一阶段：接触几何 C1（docs/engineering/m4-final-round-plan.md §1，预注册）。
 * 对照 C1-0 = A2 的 g80-s1.4-b0.05（圆角圆柱平底）；C1-a / C1-b = 平底 / 橡胶改为微凸球冠 ρ = 0.25 / 0.35。其余设置全部固定。
 * 每臂跑 M4-A 单台套件（36 台，种子同 A2），逐子步记录接地点、接地法线、滑移、接地摩擦对自转轴的力矩（按接触类别归因）、
 * 能量（自转 / 横向转动 / 平动 / 势能）与姿态；按 C1–C4 判定。输出行首 M4C1-，同时写入 test-results/diag-out.jsonl。
 * 所有开关只在本文件运行期间设置，结束后恢复（golden 不受影响）。
 */
import type RAPIER from '@dimforge/rapier3d-compat';
import { test } from 'vitest';
import { ARENA, floorNormal } from '../../src/game/arena/arenaSpec';
import { FINISH_TUNING } from '../../src/game/battle/BattleSystem';
import { BEY_TUNING, type BeyPhysics } from '../../src/game/beys/BeyPhysics';
import type { AssembledBey } from '../../src/game/beys/parts/assemble';
import { SIGNATURE_LIST } from '../../src/game/beys/parts/catalog';
import { FLAT_TIP, GYRO_EXPERIMENT } from '../../src/game/physics/gyro';
import { loadRapier, PHYSICS_EXPERIMENT, type PhysicsWorld } from '../../src/game/physics/PhysicsWorld';
import { median, r2, r3 } from './m4.metrics';
import { soloSuite, type SoloRec } from './m4.runs';
import { out } from './m5b.shared';

const G = 80;
const S = 1.4;
const SWITCHES = { enabled: 1, pd: 0, tiltDrive: 1, explicitDrive: 0, scrape: 0 };
const ARMS: Record<string, { flatTip: number; capRadius?: number }> = {
  'C1-0': { flatTip: 1 },
  'C1-a': { flatTip: 2, capRadius: 0.25 },
  'C1-b': { flatTip: 2, capRadius: 0.35 },
};
const SIGS: string[] = SIGNATURE_LIST.map((s) => s.key);

interface Manifold {
  numSolverContacts(): number;
  solverContactDist(i: number): number;
  solverContactPoint(i: number): { x: number; y: number; z: number } | null;
  normal(): { x: number; y: number; z: number };
}

const prep = (spec: AssembledBey): AssembledBey => ({ ...spec, maxSpin: spec.maxSpin * S, bit: { ...spec.bit, spinDecay: spec.bit.spinDecay * S } });

function withArm<T>(arm: { flatTip: number; capRadius?: number }, fn: () => T): T {
  const gy = { ...GYRO_EXPERIMENT };
  const ph = { ...PHYSICS_EXPERIMENT };
  const ft = { ...FLAT_TIP };
  const fin = { stopSpin: FINISH_TUNING.stopSpin, toppleSpin: FINISH_TUNING.toppleSpin };
  const bt = { minStableSpin: BEY_TUNING.minStableSpin, railSpinCost: BEY_TUNING.railSpinCost };
  Object.assign(GYRO_EXPERIMENT, SWITCHES, { flatTip: arm.flatTip });
  Object.assign(PHYSICS_EXPERIMENT, { substeps: 4, gravity: G, floorFriction: 20 / G });
  FLAT_TIP.border = 0.05;
  if (arm.capRadius !== undefined) FLAT_TIP.capRadius = arm.capRadius;
  FINISH_TUNING.stopSpin = fin.stopSpin * S;
  FINISH_TUNING.toppleSpin = fin.toppleSpin * S;
  BEY_TUNING.minStableSpin = bt.minStableSpin * S;
  BEY_TUNING.railSpinCost = bt.railSpinCost * S;
  try {
    return fn();
  } finally {
    Object.assign(GYRO_EXPERIMENT, gy);
    Object.assign(PHYSICS_EXPERIMENT, ph);
    Object.assign(FLAT_TIP, ft);
    Object.assign(FINISH_TUNING, fin);
    Object.assign(BEY_TUNING, bt);
  }
}

interface Acc {
  subs: number;
  tipTouch: number;
  partTouch: number;
  d: number[];
  nAng: number[];
  slip: number[];
  /** 自转掉速（rad/s，正 = 掉）按接触类别：只有轴心触地 / 有非轴心部件触地 / 都没有 */
  lossTip: number;
  lossPart: number;
  lossNone: number;
  /** 只有轴心触地的子步：接地摩擦对自转轴的力矩 I_a·Δω/dt */
  tauTip: number[];
  eSpin: number;
  eTr: number;
  eLin: number;
  ePot: number;
  e0: number | null;
  e1: number;
}
const newAcc = (): Acc => ({ subs: 0, tipTouch: 0, partTouch: 0, d: [], nAng: [], slip: [], lossTip: 0, lossPart: 0, lossNone: 0, tauTip: [], eSpin: 0, eTr: 0, eLin: 0, ePot: 0, e0: null, e1: 0 });

/** 逐子步只读记录（包一层 afterStep） */
function instrument(pw: PhysicsWorld, bey: BeyPhysics, floor: RAPIER.Collider) {
  const bins = Array.from({ length: 10 }, newAcc);
  const series: number[][] = [];
  const mp = bey.massProps;
  const tip = bey.colliders[0];
  const parts = bey.colliders.slice(1);
  const I = bey.body.principalInertia();
  const massInfo = { m: r3(mp.mass), Ia: r3(mp.Ia), It: r3(mp.It), comY: r3(mp.comY), rapierMass: r3(bey.body.mass()), rapierPrincipal: [I.x, I.y, I.z].map(r3), rapierComY: r3(bey.body.localCom().y) };
  let prevNet = bey.ledger.contactLoss - bey.ledger.contactGain;
  let n = 0;
  const after = pw.afterStep;
  pw.afterStep = (dt) => {
    after?.(dt);
    const acc = bins[Math.max(0, Math.min(9, Math.floor(bey.spinRatio * 10)))];
    acc.subs++;
    n++;
    let tipTouch = false;
    let best: { x: number; y: number; z: number } | null = null;
    let bestD = Infinity;
    let nrm: { x: number; y: number; z: number } | null = null;
    pw.world.contactPair(tip, floor, (m: Manifold) => {
      for (let i = 0, k = m.numSolverContacts(); i < k; i++) {
        const dd = m.solverContactDist(i);
        if (dd <= 1e-3) {
          tipTouch = true;
          if (dd < bestD) {
            const sp = m.solverContactPoint(i);
            if (sp) {
              bestD = dd;
              best = { x: sp.x, y: sp.y, z: sp.z };
              const nn = m.normal();
              nrm = { x: nn.x, y: nn.y, z: nn.z };
            }
          }
        }
      }
    });
    let partTouch = false;
    for (const c of parts)
      pw.world.contactPair(c, floor, (m: Manifold) => {
        for (let i = 0, k = m.numSolverContacts(); i < k; i++) if (m.solverContactDist(i) <= 1e-3) partTouch = true;
      });
    if (tipTouch) acc.tipTouch++;
    if (partTouch) acc.partTouch++;
    const u = bey.up();
    const w = bey.body.angvel();
    const v = bey.body.linvel();
    const ws = w.x * u.x + w.y * u.y + w.z * u.z;
    const px = w.x - u.x * ws;
    const py = w.y - u.y * ws;
    const pz = w.z - u.z * ws;
    const com = bey.comWorld();
    if (best && nrm) {
      const c = best as { x: number; y: number; z: number };
      const nm = nrm as { x: number; y: number; z: number };
      const o = bey.body.translation();
      const ox = c.x - o.x;
      const oy = c.y - o.y;
      const oz = c.z - o.z;
      const al = ox * u.x + oy * u.y + oz * u.z;
      acc.d.push(Math.hypot(ox - u.x * al, oy - u.y * al, oz - u.z * al));
      const rr = Math.hypot(c.x, c.z);
      const fn = rr <= ARENA.radius ? floorNormal(c.x, c.z) : [0, 1, 0];
      acc.nAng.push(Math.acos(Math.min(1, Math.abs(nm.x * fn[0] + nm.y * fn[1] + nm.z * fn[2]))));
      const rx = c.x - com.x;
      const ry = c.y - com.y;
      const rz = c.z - com.z;
      const vx = v.x + (w.y * rz - w.z * ry);
      const vy = v.y + (w.z * rx - w.x * rz);
      const vz = v.z + (w.x * ry - w.y * rx);
      const vn = vx * fn[0] + vy * fn[1] + vz * fn[2];
      acc.slip.push(Math.hypot(vx - vn * fn[0], vy - vn * fn[1], vz - vn * fn[2]));
    }
    const net = bey.ledger.contactLoss - bey.ledger.contactGain;
    const dLoss = net - prevNet;
    prevNet = net;
    if (partTouch) acc.lossPart += dLoss;
    else if (tipTouch) {
      acc.lossTip += dLoss;
      acc.tauTip.push((mp.Ia * dLoss) / dt);
    } else acc.lossNone += dLoss;
    const eSpin = 0.5 * mp.Ia * ws * ws;
    const eTr = 0.5 * mp.It * (px * px + py * py + pz * pz);
    const eLin = 0.5 * mp.mass * (v.x * v.x + v.y * v.y + v.z * v.z);
    const ePot = mp.mass * pw.g * com.y;
    acc.eSpin += eSpin;
    acc.eTr += eTr;
    acc.eLin += eLin;
    acc.ePot += ePot;
    const eTot = eSpin + eTr + eLin + ePot;
    if (acc.e0 === null) acc.e0 = eTot;
    acc.e1 = eTot;
    if (n % Math.round(0.5 / dt) === 0) {
      let tilt = 0;
      const rr = Math.hypot(com.x, com.z);
      const fn = rr <= ARENA.radius ? floorNormal(com.x, com.z) : [0, 1, 0];
      tilt = Math.acos(Math.max(-1, Math.min(1, u.x * fn[0] + u.y * fn[1] + u.z * fn[2])));
      series.push([r2(n * dt), r3(bey.spinRatio), r3(tilt), tipTouch ? 1 : 0, partTouch ? 1 : 0, r2(eSpin), r2(eTr), r2(eLin), r2(ePot)]);
    }
  };
  return () => ({
    // 结束时世界已经释放，这里只返回记录好的数据（不再访问 Rapier 对象）
    mass: massInfo,
    bins: bins
      .map((b, i) => ({ b, i }))
      .filter(({ b }) => b.subs > 0)
      .reverse()
      .map(({ b, i }) => {
        const sec = b.subs * pw.stepDt;
        return {
          ratio: `${(i / 10).toFixed(1)}–${((i + 1) / 10).toFixed(1)}`,
          seconds: r2(sec),
          tipTouchShare: r3(b.tipTouch / b.subs),
          partTouchShare: r3(b.partTouch / b.subs),
          dP50: r3(median(b.d)),
          normalAngleP50: r3(median(b.nAng)),
          slipP50: r3(median(b.slip)),
          lossRate: { tip: r3(b.lossTip / sec), part: r3(b.lossPart / sec), none: r3(b.lossNone / sec) },
          tauTipP50: r3(median(b.tauTip)),
          energyMean: { spin: r2(b.eSpin / b.subs), transverse: r3(b.eTr / b.subs), linear: r3(b.eLin / b.subs), potential: r2(b.ePot / b.subs) },
          dEdt: r3(((b.e1 - (b.e0 ?? b.e1)) / sec) || 0),
        };
      }),
    series,
  });
}

type Bin = { ratio: string; seconds: number; speed: number; precession: number };
const binsOf = (by: Record<string, Record<string, unknown>>, k: string) => by[k].bins as Bin[];
const getBin = (bins: Bin[], lo: string) => bins.find((b) => b.ratio.startsWith(lo));
function weightedSpeed(bins: Bin[], los: string[]) {
  const bs = los.map((l) => getBin(bins, l)).filter((b): b is Bin => !!b);
  const s = bs.reduce((a, b) => a + b.seconds, 0);
  return s ? bs.reduce((a, b) => a + b.speed * b.seconds, 0) / s : NaN;
}
function e2a(bins: Bin[]) {
  const hi = [getBin(bins, '0.9'), getBin(bins, '0.8')].filter((b): b is Bin => !!b);
  const s = hi.reduce((a, b) => a + b.seconds, 0);
  const top = s ? hi.reduce((a, b) => a + b.speed * b.seconds, 0) / s : NaN;
  return (getBin(bins, '0.5')?.speed ?? NaN) / top;
}
type InstrBin = { ratio: string; seconds: number; tipTouchShare: number };

function gates(solo: ReturnType<typeof soloSuite>) {
  const by = solo.byName as Record<string, Record<string, unknown>>;
  const sig = solo.recs.filter((x: SoloRec) => SIGS.includes(x.name));
  // C1 接地异常
  const rollMax = Math.max(...solo.recs.map((x) => x.rollInPlaceMax));
  const touch: Record<string, number> = {};
  for (const k of ['lieren', 'senheng']) {
    const per = sig
      .filter((x) => x.name === k)
      .map((x) => {
        const bs = ((x.instr as { bins: InstrBin[] }).bins ?? []).filter((b) => {
          const lo = Number(b.ratio.slice(0, 3));
          return lo >= 0.3 && lo < 0.9;
        });
        const s = bs.reduce((a, b) => a + b.seconds, 0);
        return s ? bs.reduce((a, b) => a + b.tipTouchShare * b.seconds, 0) / s : NaN;
      });
    touch[k] = r3(median(per));
  }
  const C1 = { rollInPlaceMax: r2(rollMax), tipTouchMid: touch, pass: rollMax < 2 && Object.values(touch).every((v) => v >= 0.8) };
  // C2 自然低速失衡
  const per: Record<string, number> = {};
  for (const k of SIGS) per[k] = sig.filter((x) => x.name === k && x.destabDuration !== null).length;
  const dP50 = median(sig.map((x) => x.destabDuration).filter((v): v is number => v !== null));
  const excMax = Math.max(...sig.map((x) => x.excursionAbove03));
  const C2 = { destabRunsOf6: per, destabP50: r2(dP50), excursionAbove03Max: r2(excMax), pass: SIGS.every((k) => per[k] >= 4) && dP50 >= 1 && dP50 <= 4 && excMax < 0.2 };
  // C3 进动随转速下降而增强
  const prec: Record<string, [number | null, number | null]> = {};
  let up = 0;
  for (const k of SIGS) {
    const b = binsOf(by, k);
    const lo = getBin(b, '0.2')?.precession ?? null;
    const hi = getBin(b, '0.6')?.precession ?? null;
    prec[k] = [hi, lo];
    if (lo !== null && hi !== null && lo > hi) up++;
  }
  const C3 = { precession06vs02: prec, increasing: up, pass: up >= 3 };
  // C4 四种构筑合理差异
  const mid = (k: string) => weightedSpeed(binsOf(by, k), ['0.3', '0.4', '0.5', '0.6']);
  const vP = mid('pandun');
  const C4 = {
    midSpeed: Object.fromEntries(SIGS.map((k) => [k, r3(mid(k))])),
    rMidOverR: { lieren: r3((by.lieren.rMidP50 as number) / ARENA.radius), senheng: r3((by.senheng.rMidP50 as number) / ARENA.radius) },
    e2a: { lieren: r3(e2a(binsOf(by, 'lieren'))), senheng: r3(e2a(binsOf(by, 'senheng'))) },
    pass: false,
  };
  C4.pass =
    ['lieren', 'senheng'].every((k) => mid(k) >= 1.5 * vP) &&
    Object.values(C4.rMidOverR).every((v) => v >= 0.25) &&
    Object.values(C4.e2a).every((v) => v >= 0.65);
  const pass = C1.pass && C2.pass && C3.pass && C4.pass;
  const rollTotal = solo.recs.reduce((a, x) => a + x.rollInPlaceMax, 0);
  return { pass, C1, C2, C3, C4, rollTotal: r2(rollTotal), minE2a: r3(Math.min(...Object.values(C4.e2a))) };
}

const results: { arm: string; pass: boolean; rollTotal: number; minE2a: number; failed: string[] }[] = [];

for (const [arm, cfg] of Object.entries(ARMS))
  test(`M4 C1 ${arm}`, async () => {
    const R = await loadRapier();
    const res = withArm(cfg, () => {
      const solo = soloSuite(R, { prep, instrument });
      return { solo, gt: gates(solo) };
    });
    for (const x of res.solo.recs) out('M4C1-RUN', { arm, ...x });
    out('M4C1-SOLO', { arm, ms: res.solo.ms, byName: res.solo.byName });
    out('M4C1-GATES', { arm, ...cfg, g: G, s: S, gates: res.gt });
    results.push({ arm, pass: res.gt.pass, rollTotal: res.gt.rollTotal, minE2a: res.gt.minE2a, failed: (['C1', 'C2', 'C3', 'C4'] as const).filter((k) => !res.gt[k].pass) });
  }, 3_000_000);

test('M4 C1 结论', () => {
  const passing = results.filter((x) => x.arm !== 'C1-0' && x.pass).sort((a, b) => a.rollTotal - b.rollTotal || b.minE2a - a.minE2a);
  out('M4C1-RESULT', { arms: results, passing: passing.map((x) => x.arm), selected: passing.length ? passing[0].arm : null, stopCondition: passing.length === 0 });
});
