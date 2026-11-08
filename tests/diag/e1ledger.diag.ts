/**
 * E1：针尖对针尖低速停滞的水平力来源分解（逐步力学账本）。
 *   E1_OUT=目录（默认 test-results/e1e2/e1-<A|B>）  E2_GRIP=0.05（只对本诊断的针尖对针尖场次覆盖 driveMinGrip）
 * 场景：探针 V2 矩阵中全部 24 场针尖对针尖（固定种子）。窗口：每场最长低速段（V2 WATCH(0.4) 口径）的前 10 s，不筛选。
 * 输出：summary.json（逐场、逐窗口、逐项汇总 + 全部低速步汇总）、win/*.csv.gz（窗口内每个物理步、每台的完整账本）、hash.json。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { test } from 'vitest';
import { ARENA } from '../../src/game/arena/arenaSpec';
import { BEY_TUNING } from '../../src/game/beys/BeyPhysics';
import { GRAVITY, loadRapier, PHYSICS_DT } from '../../src/game/physics/PhysicsWorld';
import { seeded } from '../motion/motionSim';
import { instrument, isNN, LowSpeed, withDriveMinGrip, type Ledger, type V } from './e1e2.shared';
import { fingerprint, scenariosV2, setup } from './stallprobe2.shared';

const TERMS = ['trac', 'roll', 'dash', 'smash', 'damp', 'nFloor', 'nStatic', 'nBey', 'fric', 'unexpl'] as const;
type Term = (typeof TERMS)[number];
const COLS = [
  't', 'px', 'pz', 'r', 'speed', 'v0x', 'v0z', 'spin', 'tilt', 'low', 'geo', 'kind', 'tracOn',
  'dvx', 'dvz',
  ...TERMS.flatMap((k) => [`${k}X`, `${k}Z`]),
  'unexplY', 'fricMag', 'lamFloor', 'cone', 'nx', 'ny', 'nz', 'slipX', 'slipZ', 'slipLinX', 'slipLinZ', 'slipSpinX', 'slipSpinZ', 'slipPerpX', 'slipPerpZ', 'natX', 'natZ', 'upX', 'upZ', 'tangentRead', 'preErr', 'postErr', 'unclassified',
] as const;
const KIND = { none: 0, floor: 1, mixed: 2, other: 3 } as const;

/** 解析式碗面坡度 dh/dr（与 arenaSpec.floorHeight 同式，只用于“理论值”对照，不当作 Rapier 实际施力） */
function slope(r: number) {
  const s = ARENA;
  const e = Math.max(0, r - s.centerFlat);
  const o = Math.max(0, r - s.edgeStart);
  return (e > 0 ? s.bowl * (2 * e + 2 * s.centerFlat) : 0) + 0.008 * r + 3 * s.edge * o * o;
}

test('E1 ledger', async () => {
  const R = await loadRapier();
  const grip = process.env.E2_GRIP ? Number(process.env.E2_GRIP) : null;
  const tag = grip === null ? 'A' : 'B';
  const outDir = process.env.E1_OUT ?? `test-results/e1e2/e1-${tag}`;
  mkdirSync(join(outDir, 'win'), { recursive: true });
  const runs: unknown[] = [];
  const hashes: unknown[] = [];
  // 全部低速步汇总（24 场合计，每台每步一个样本）
  const all = newAgg();
  for (const sc of scenariosV2()) {
    const orig = Math.random;
    Math.random = seeded(sc.seed);
    let nn = false;
    try {
      const probe = setup(R, sc);
      nn = isNN([probe.A, probe.B]);
      probe.pw.dispose();
    } finally {
      Math.random = orig;
    }
    if (!nn) continue;
    if (process.env.E1_ONLY && sc.name !== process.env.E1_ONLY) continue;
    Math.random = seeded(sc.seed);
    try {
      withDriveMinGrip(grip, () => {
        const { pw, b, A, B } = setup(R, sc);
        const beys = [A, B] as [typeof A, typeof B];
        const ins = instrument(R, pw, b, beys, true);
        const h = createHash('sha256');
        const max = (sc.maxSeconds ?? 60) / PHYSICS_DT;
        const rows: Float64Array[][] = [[], []];
        const lowF: number[] = [];
        const ls = new LowSpeed();
        let tangentMax = 0;
        let unclassified = 0;
        let preErrMax = 0;
        let postErrMax = 0;
        let s = 0;
        for (; s < max && !b.result; s++) {
          pw.step();
          fingerprint(h, beys);
          const low = ls.step(b, A, B);
          lowF.push(low ? 1 : 0);
          beys.forEach((x, i) => {
            const L = ins.led[i];
            tangentMax = Math.max(tangentMax, L.tangentRead);
            unclassified += L.unclassified;
            preErrMax = Math.max(preErrMax, L.preErr);
            postErrMax = Math.max(postErrMax, L.postErr);
            rows[i].push(row(x, L, (s + 1) * PHYSICS_DT, low, b.contactClass.geometric));
          });
        }
        const hash = h.digest('hex');
        hashes.push({ name: sc.name, hash, steps: s });
        // 最长低速段
        let best = { i0: 0, len: 0 };
        let cur = 0;
        for (let k = 0; k < lowF.length; k++) {
          cur = lowF[k] ? cur + 1 : 0;
          if (cur > best.len) best = { i0: k - cur + 1, len: cur };
        }
        const W = Math.round(10 / PHYSICS_DT);
        const win = best.len >= W ? { i0: best.i0, i1: best.i0 + W } : null;
        const per: unknown[] = [];
        for (let i = 0; i < 2; i++) {
          const agg = newAgg();
          for (let k = 0; k < rows[i].length; k++) {
            if (lowF[k]) accumulate(all, rows[i][k], beys[i].body.mass());
            if (win && k >= win.i0 && k < win.i1) accumulate(agg, rows[i][k], beys[i].body.mass());
          }
          per.push(win ? finishAgg(agg) : null);
        }
        if (win) {
          const csv = [['bey', ...COLS].join(',')];
          for (let i = 0; i < 2; i++) for (let k = win.i0; k < win.i1; k++) csv.push([i, ...Array.from(rows[i][k], (v) => (Number.isInteger(v) ? v : +v.toPrecision(6)))].join(','));
          writeFileSync(join(outDir, 'win', `${sc.name.replace(/[^\w.#-]+/g, '_').replace('#', '_')}.csv.gz`), gzipSync(csv.join('\n')));
        }
        runs.push({
          name: sc.name,
          group: sc.group,
          seed: sc.seed,
          hash,
          steps: s,
          result: b.result ? `${b.result.winner}:${b.result.finish}` : 'timeout',
          lowLongest: best.len * PHYSICS_DT,
          window: win ? { t0: win.i0 * PHYSICS_DT, t1: win.i1 * PHYSICS_DT } : null,
          perBey: per,
          checks: { tangentReadMax: tangentMax, unclassified, preErrMax, postErrMax },
          driveMinGrip: BEY_TUNING.driveMinGrip,
        });
        pw.dispose();
      });
    } finally {
      Math.random = orig;
    }
  }
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify({ tag, grip, cols: COLS, runs, allLow: finishAgg(all) }, null, 1));
  writeFileSync(join(outDir, 'hash.json'), JSON.stringify({ tag, grip, runs: hashes }, null, 1));
}, 7_200_000);

function row(x: import('../../src/game/beys/BeyPhysics').BeyPhysics, L: Ledger, t: number, low: boolean, geo: boolean): Float64Array {
  const p = x.body.translation();
  const up = x.up();
  const prec = (x as unknown as { precession: number }).precession;
  const sgn = x.spinDirection;
  const v: number[] = [
    t, p.x, p.z, Math.hypot(p.x, p.z), Math.hypot(L.v3.x, L.v3.z), L.v0.x, L.v0.z, x.spin, x.tilt, low ? 1 : 0, geo ? 1 : 0, KIND[L.kind], L.tracOn ? 1 : 0,
    L.v3.x - L.v0.x, L.v3.z - L.v0.z,
  ];
  for (const k of TERMS) {
    const q = L[k] as V;
    v.push(q.x / L.m, q.z / L.m);
  }
  v.push(L.unexpl.y / L.m, Math.hypot(L.fric.x, L.fric.y, L.fric.z) / L.m, L.lamFloor, L.cone, L.floorN.x, L.floorN.y, L.floorN.z, L.slip.x, L.slip.z, L.slipLin.x, L.slipLin.z, L.slipSpin.x, L.slipSpin.z, L.slipPerp.x, L.slipPerp.z, -Math.sin(prec) * sgn, Math.cos(prec) * sgn, up.x, up.z, L.tangentRead, L.preErr, L.postErr, L.unclassified);
  return Float64Array.from(v);
}

const C = Object.fromEntries(COLS.map((c, i) => [c, i])) as Record<(typeof COLS)[number], number>;

function newAgg() {
  const z = () => Object.fromEntries(TERMS.map((k) => [k, 0])) as Record<Term, number>;
  return {
    n: 0,
    kinds: [0, 0, 0, 0],
    tracSteps: 0,
    speed: [] as number[],
    /** 每项：|Δv| 之和、沿速度方向分量之和、净向量和 */
    mag: z(),
    along: z(),
    power: z(),
    sumX: z(),
    sumZ: z(),
    dvMag: 0,
    dvSumX: 0,
    dvSumZ: 0,
    /** 每步相对残差 |unexpl_h| / |Δv_h| */
    rel: [] as number[],
    /** 摩擦检验：锥比、法向残差比、与 −滑移方向的夹角、与 −v̂ / 自然牵引方向 / 下坡方向 的夹角 */
    coneRatio: [] as number[],
    angSlip: [] as number[],
    angVel: [] as number[],
    angNat: [] as number[],
    angDown: [] as number[],
    fricAcc: [] as number[],
    /** 法向冲量水平分量（实测）与解析坡度理论值的对照：径向分量 m/s² */
    nRadial: [] as number[],
    gTheory: [] as number[],
    unexplVertRel: [] as number[],
    slipLin: [] as number[],
    slipSpin: [] as number[],
    slipPerp: [] as number[],
    angSpin: [] as number[],
    lineTilt: [] as number[],
    angPerp: [] as number[],
    smashSteps: 0,
    smashNoGeo: 0,
  };
}
type Agg = ReturnType<typeof newAgg>;

const ang = (ax: number, az: number, bx: number, bz: number) => {
  const la = Math.hypot(ax, az);
  const lb = Math.hypot(bx, bz);
  if (la < 1e-12 || lb < 1e-12) return NaN;
  return (Math.acos(Math.max(-1, Math.min(1, (ax * bx + az * bz) / la / lb))) * 180) / Math.PI;
};

function accumulate(a: Agg, r: Float64Array, m: number) {
  void m;
  a.n++;
  a.kinds[r[C.kind]]++;
  if (r[C.tracOn]) a.tracSteps++;
  a.speed.push(r[C.speed]);
  const v0x = r[C.v0x];
  const v0z = r[C.v0z];
  const vl = Math.hypot(v0x, v0z);
  const ux = vl > 1e-6 ? v0x / vl : 0;
  const uz = vl > 1e-6 ? v0z / vl : 0;
  const dvx = r[C.dvx];
  const dvz = r[C.dvz];
  const dvm = Math.hypot(dvx, dvz);
  a.dvMag += dvm;
  a.dvSumX += dvx;
  a.dvSumZ += dvz;
  for (const k of TERMS) {
    const x = r[C[`${k}X`]];
    const z = r[C[`${k}Z`]];
    a.mag[k] += Math.hypot(x, z);
    a.along[k] += x * ux + z * uz;
    a.power[k] += x * v0x + z * v0z;
    a.sumX[k] += x;
    a.sumZ[k] += z;
  }
  if (dvm > 1e-9) a.rel.push(Math.hypot(r[C.unexplX], r[C.unexplZ]) / dvm);
  a.unexplVertRel.push(Math.abs(r[C.unexplY]) / (-GRAVITY * PHYSICS_DT));
  const fx = r[C.fricX];
  const fz = r[C.fricZ];
  if (Math.hypot(r[C.smashX], r[C.smashZ]) > 0) {
    a.smashSteps++;
    if (!r[C.geo]) a.smashNoGeo++;
  }
  if (r[C.kind] === 1) {
    a.slipLin.push(Math.hypot(r[C.slipLinX], r[C.slipLinZ]));
    a.slipSpin.push(Math.hypot(r[C.slipSpinX], r[C.slipSpinZ]));
    a.slipPerp.push(Math.hypot(r[C.slipPerpX], r[C.slipPerpZ]));
    a.angSpin.push(ang(fx, fz, -r[C.slipSpinX], -r[C.slipSpinZ]));
    // 摩擦方向与“垂直于实际转轴倾斜方向”的直线夹角（0–90°，不分正反）
    const lt = ang(fx, fz, -r[C.upZ], r[C.upX]);
    a.lineTilt.push(Number.isFinite(lt) ? Math.min(lt, 180 - lt) : NaN);
    a.angPerp.push(ang(fx, fz, -r[C.slipPerpX], -r[C.slipPerpZ]));
    if (r[C.cone] > 0) a.coneRatio.push((r[C.fricMag] * m) / r[C.cone]);
    a.angSlip.push(ang(fx, fz, -r[C.slipX], -r[C.slipZ]));
    if (vl > 1e-6) a.angVel.push(ang(fx, fz, -v0x, -v0z));
    a.angNat.push(ang(fx, fz, r[C.natX], r[C.natZ]));
    const px = r[C.px];
    const pz = r[C.pz];
    a.angDown.push(ang(fx, fz, -px, -pz));
    a.fricAcc.push(Math.hypot(fx, fz) / PHYSICS_DT);
    const rr = Math.hypot(px, pz);
    if (rr > 1e-6) {
      a.nRadial.push((r[C.nFloorX] * px + r[C.nFloorZ] * pz) / rr / PHYSICS_DT);
      const sl = slope(rr);
      a.gTheory.push((-(-GRAVITY) * sl) / (1 + sl * sl));
    }
  }
}

function stats(x: number[]) {
  const a = x.filter((v) => Number.isFinite(v)).sort((p, q) => p - q);
  if (!a.length) return { n: 0 };
  const q = (p: number) => a[Math.min(a.length - 1, Math.max(0, Math.ceil(p * a.length) - 1))];
  return { n: a.length, mean: a.reduce((p, v) => p + v, 0) / a.length, p10: q(0.1), p50: q(0.5), p90: q(0.9), max: a[a.length - 1] };
}

function finishAgg(a: Agg) {
  const T = a.n * PHYSICS_DT;
  const terms = Object.fromEntries(
    TERMS.map((k) => [
      k,
      {
        /** 平均水平加速度大小（m/s²）、沿速度方向的平均加速度（正 = 推动）、净 Δv 向量和（m/s） */
        meanAcc: a.mag[k] / T,
        alongAcc: a.along[k] / T,
        netDv: Math.hypot(a.sumX[k], a.sumZ[k]),
        share: a.mag[k] / TERMS.reduce((p, kk) => p + a.mag[kk], 0),
        /** 平均功率（每 kg，W/kg = Δv·v / dt 的平均）：正 = 增加动能 */
        power: a.power[k] / T,
      },
    ]),
  );
  return {
    steps: a.n,
    seconds: T,
    kinds: { none: a.kinds[0], floor: a.kinds[1], mixed: a.kinds[2], other: a.kinds[3] },
    tracSteps: a.tracSteps,
    speed: stats(a.speed),
    dv: { meanAcc: a.dvMag / T, netDv: Math.hypot(a.dvSumX, a.dvSumZ) },
    terms,
    rel: stats(a.rel),
    unexplVertRel: stats(a.unexplVertRel),
    coneRatio: stats(a.coneRatio),
    angSlip: stats(a.angSlip),
    angVel: stats(a.angVel),
    angNat: stats(a.angNat),
    angDown: stats(a.angDown),
    fricAcc: stats(a.fricAcc),
    nRadial: stats(a.nRadial),
    gTheory: stats(a.gTheory),
    slipLin: stats(a.slipLin),
    slipSpin: stats(a.slipSpin),
    slipPerp: stats(a.slipPerp),
    angSpin: stats(a.angSpin),
    lineTilt: stats(a.lineTilt),
    angPerp: stats(a.angPerp),
    smashSteps: a.smashSteps,
    smashNoGeo: a.smashNoGeo,
  };
}
