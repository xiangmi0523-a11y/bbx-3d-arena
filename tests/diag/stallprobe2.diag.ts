/**
 * 低速停滞探针 V2：第二轮受控数据采集（只读观测，不实现恢复机制，不改物理）。
 *
 * 与 V1（stallprobe.diag.ts）的区别：
 *  A. 每步记录双方绝对 X/Z、水平速度、本步位移、累计路径；WATCH 段从进入时刻起在 1/2/3/5/10 s 各取一次
 *     真实净位移（当时位置 − 进入位置）与累计路径，两者分别记录，不互相推算
 *  B. 完整接触证据向量（按 4×4 碰撞体对分别记录，不压缩）：manifold 数、接触点数、求解器接触点数、
 *     min contactDist、min solverContactDist、法向冲量和、正冲量点数、每对的三维形状距离、XZ 几何间隙
 *     四类划分只用于组织数据，原始字段全部保留：
 *       real    = 求解器接触点距离 ≤ 0（穿透）或 有正法向冲量
 *       predict = 有 manifold 接触点 / 求解器接触点，但距离 > 0 且没有正冲量（预测距离内接近）
 *       geom    = 没有任何 manifold 接触点，但三维形状距离 ≤ 1 cm 或 XZ 刀刃投影重叠
 *       none    = 以上都没有
 *  C. BattleSystem.sampleContact() 提前返回盲区：用 BattleSystem.contactQueries 的增量判断正式采样是否提前返回
 *     （并与复算的提前返回条件对照），探针自己的接触查询与它无关，逐步都做
 *  D. 牵引有效性：BeyPhysics.probe（只写）给出每步牵引被哪一道条件挡住 / 是否施加，配合意图、转速比、实际运动
 *  E. 恢复候选快照：WATCH(0.4) 持续 0.6 s 时（与 R1 同一触发点）记录双方距离、速度、方向、意图、转速比；
 *     R1 对照（R1=a / b，与 V1 相同，参数不变）在启动时记录同一快照
 *  F. wobble 触发现场：几何、接触向量、碰撞体对、倾角、转速、意图 / breakout / R1 状态
 *
 * 只读：探针只调用 Rapier 查询（contactPair / contactCollider）与读取刚体 / 实例状态；BeyPhysics.probe 只被写入。
 * 物理一致性用跨树对照证明（stallprobe2-plain.diag.ts 在干净 cb4c2c4 工作树运行，scripts/stallprobe2-verify.mjs 比对）。
 *
 * 环境变量：
 *   SP_OUT=目录（默认 test-results/stallprobe2/<SP_VERSION>）  SP_VERSION=名字  SP_GROUPS=AvD,...
 *   SP_SERIES=场景名,...（输出逐步全字段 CSV + 逐碰撞体对接触 CSV）；所有场次都输出精简轨迹 track/*.csv.gz
 *   DIAG_TUNE='{"stallBreak":1}'  R1=a|b  R1_GRIP  R1_T（同 V1）
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { test } from 'vitest';
import { ARENA } from '../../src/game/arena/arenaSpec';
import { BEY_TUNING, type BeyPhysics, type TractionProbe } from '../../src/game/beys/BeyPhysics';
import { loadRapier, PHYSICS_DT } from '../../src/game/physics/PhysicsWorld';
import { seeded } from '../motion/motionSim';
import { fingerprint, scenariosV2, setup, type R, type Scn } from './stallprobe2.shared';

if (process.env.DIAG_TUNE) Object.assign(BEY_TUNING, JSON.parse(process.env.DIAG_TUNE));

const r4 = (x: number) => (Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : x);
const r5 = (x: number) => (Number.isFinite(x) ? Math.round(x * 1e5) / 1e5 : x);
const WV = [0.2, 0.4, 0.8];
const CK = [1, 2, 3, 5, 10];
const SPIN_MIN = 10;
const H_WATCH = 6;
const CN = ['ball', 'shaft', 'disc', 'blade'];
const CLS = ['none', 'geom', 'predict', 'real'] as const;
const SPEED_BINS = [0.05, 0.1, 0.2, 0.4, 0.8, 1.6, Infinity];
const TSTATES = ['applied', 'gripLow', 'inelig', 'edgeBlock', 'cap', 'other'] as const;
const deg = (c: number) => (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;

interface Mv {
  x: number;
  z: number;
  speed: number;
  vx: number;
  vz: number;
  step: number;
  path: number;
  spin: number;
  ratio: number;
  tilt: number;
  r: number;
  pr: TractionProbe;
  tstate: (typeof TSTATES)[number];
  dirVsIntent: number;
  dirVsOpp: number;
  velVsOpp: number;
  headVsOpp: number;
  intent: string;
  auth: number;
  bo: number;
}

const SERIES_COLS = [
  't', 'cls', 'manifolds', 'nContacts', 'nSolver', 'minDist', 'minSolverDist', 'impulse', 'nImpPos', 'pairsReal', 'pairsPredict',
  'dist3d', 'dist3dBlade', 'dXZ', 'outerGap', 'bladeGap', 'overlapXZ', 'closing', 'realH6', 'sampleEarly', 'sampleEarlyCalc', 'cfTouching', 'cfPhase',
  ...['a', 'b'].flatMap((s) => [`${s}X`, `${s}Z`, `${s}Speed`, `${s}Step`, `${s}Path`, `${s}Spin`, `${s}Ratio`, `${s}Tilt`, `${s}R`, `${s}TState`, `${s}Eligible`, `${s}Applied`, `${s}EdgeOnly`, `${s}EdgeHelps`, `${s}CapOk`, `${s}DriveGrip`, `${s}Accel`, `${s}DirVsIntentDeg`, `${s}DirVsOppDeg`, `${s}VelVsOppDeg`, `${s}Intent`, `${s}Authority`, `${s}Breakout`, `${s}R1`]),
  'spinAoverB', 'watch02', 'watch04', 'watch08', 'stallFor', 'wobbleFor', 'breakouts', 'wobbleBreaks',
];
const TRACK_COLS = ['t', 'aX', 'aZ', 'bX', 'bZ', 'aSpeed', 'bSpeed', 'aSpin', 'bSpin', 'cls', 'nSolver', 'minSolverDist', 'impulse', 'dist3d', 'aApplied', 'bApplied', 'watch04'];
const PAIR_COLS = ['t', 'pair', 'nContacts', 'nSolver', 'minDist', 'minSolverDist', 'impulse', 'nImpPos', 'dist3d'];

type Ep = {
  t0: number;
  start: { x: number; z: number }[];
  path: number[];
  steps: number;
  cls: number[];
  overlap: number;
  gapMin: number;
  gapMax: number;
  d0: number;
  dMin: number;
  spin0: number[];
  ratio0: number[];
  r0: number[];
  rMax: number[];
  speedSum: number[];
  speedMax: number[];
  ts: number[][];
  tiltMax: number[];
  intents: Record<string, number>;
  authSum: number[];
  dirVsIntentSum: number[];
  dirVsOppSum: number[];
  closingSum: number;
  ck: Record<string, unknown>[];
  cand: Record<string, unknown> | null;
};

function snapshot(t: number, mv: Mv[], beys: BeyPhysics[], geo: { dXZ: number; dist3d: number; bladeGap: number; outerGap: number; cls: number }) {
  return {
    t: r4(t),
    dXZ: r4(geo.dXZ),
    dist3d: r4(geo.dist3d),
    bladeGap: r4(geo.bladeGap),
    outerGap: r4(geo.outerGap),
    cls: CLS[geo.cls],
    pos: mv.map((m) => [r4(m.x), r4(m.z)]),
    r: mv.map((m) => r4(m.r)),
    speed: mv.map((m) => r4(m.speed)),
    velVsOppDeg: mv.map((m) => r4(m.velVsOpp)),
    tractionVsOppDeg: mv.map((m) => r4(m.dirVsOpp)),
    headingVsOppDeg: mv.map((m) => r4(m.headVsOpp)),
    tractionVsIntentDeg: mv.map((m) => r4(m.dirVsIntent)),
    tstate: mv.map((m) => m.tstate),
    intent: mv.map((m) => m.intent),
    authority: mv.map((m) => r4(m.auth)),
    spin: mv.map((m) => r4(m.spin)),
    spinRatio: mv.map((m) => r4(m.ratio)),
    spinAoverB: r4(mv[0].spin / Math.max(1e-6, mv[1].spin)),
    tilt: mv.map((m) => r4(m.tilt)),
    tiltExcess: beys.map((x, i) => r4(mv[i].tilt - x.spec.tip.drift)),
    breakout: mv.map((m) => r4(m.bo)),
  };
}

async function probeRun(R: R, sc: Scn, wantSeries: boolean, r1: string | null, outDir: string) {
  const orig = Math.random;
  Math.random = seeded(sc.seed);
  try {
    const { pw, b, A, B } = setup(R, sc);
    const beys = [A, B];
    const probes: TractionProbe[] = beys.map(() => ({ grip: 0, driveGrip: 0, eligible: false, gripOk: false, edgeOnly: false, edgeHelps: true, capOk: false, applied: false, dx: 0, dz: 0, accel: 0 }));
    beys.forEach((x, i) => (x.probe = probes[i]));
    const h = createHash('sha256');
    const max = (sc.maxSeconds ?? 60) / PHYSICS_DT;
    const bladeSum = A.spec.blade.radius + B.spec.blade.radius;
    const outerSum = A.spec.outerRadius + B.spec.outerRadius;
    const nA = A.colliders.length;
    const nB = B.colliders.length;
    const pairName = (ia: number, ib: number) => `${CN[ia] ?? ia}-${CN[ib] ?? ib}`;
    const ip = pw.world.integrationParameters as unknown as { normalizedPredictionDistance: number; lengthUnit: number; normalizedAllowedLinearError: number; numSolverIterations: number };
    const meta = {
      predictionDistance: ip.normalizedPredictionDistance * ip.lengthUnit,
      normalizedPredictionDistance: ip.normalizedPredictionDistance,
      lengthUnit: ip.lengthUnit,
      allowedLinearError: ip.normalizedAllowedLinearError * ip.lengthUnit,
      numSolverIterations: ip.numSolverIterations,
      contactSkin: beys.map((x) => x.colliders.map((c) => r5(c.contactSkin()))),
      colliders: beys.map((x) => x.colliders.length),
      bladeSum: r4(bladeSum),
      outerSum: r4(outerSum),
      sampleEarlyRule: 'BattleSystem.sampleContact: XZ 中心距 > outerSum + 0.12 时返回 null',
    };
    const series: (number | string)[][] = [];
    const track: (number | string)[][] = [];
    const pairRows: (number | string)[][] = [];

    // ── R1 反事实（与 V1 完全相同的规则与参数） ──
    const needle = beys.map((x) => x.spec.tip.gearGrip < BEY_TUNING.driveMinGrip);
    const baseSpec = beys.map((x) => x.spec);
    const r1On = [false, false];
    const setR1 = (i: number, on: boolean) => {
      if (r1On[i] === on) return;
      r1On[i] = on;
      const x = beys[i] as unknown as { spec: typeof A.spec };
      x.spec = on && r1 === 'a' ? { ...baseSpec[i], tip: { ...baseSpec[i].tip, gearGrip: Number(process.env.R1_GRIP ?? BEY_TUNING.breakoutGrip) } } : baseSpec[i];
    };
    if (r1 === 'b') {
      beys.forEach((x, i) => {
        const it = x.intent as unknown as { update: (inp: unknown) => void; edgeW: number };
        const raw = it.update.bind(it);
        it.update = (inp) => {
          raw(inp);
          if (r1On[i] && it.edgeW < 0.5) it.edgeW = 0.5;
        };
      });
    }
    let r1WatchFor = 0;
    const r1Acts: Record<string, unknown>[] = [];
    let r1Cur: { t0: number; bey: number[]; moveT: number | null; reT: number | null; firstEvidT: number | null; path: number[]; spin0: number[]; maxR: number; wallNear: number; wobbleBefore: number; snap: unknown; dMin: number } | null = null;

    // ── 接触段（real：H=0 / H=6；real+predict：H=0） ──
    const segDefs = [
      { key: 'realH0', H: 0, on: (c: number) => c === 3 },
      { key: 'realH6', H: 6, on: (c: number) => c === 3 },
      { key: 'anyH0', H: 0, on: (c: number) => c >= 2 },
    ];
    const segs = segDefs.map(() => ({ on: false, miss: 0, start: 0, lastOff: -1, flaps: 0, durs: [] as number[], imps: [] as number[], impCur: 0 }));
    // ── 统计 ──
    const tally = {
      steps: 0,
      cls: [0, 0, 0, 0],
      realPen: 0,
      realImpOnly: 0,
      realPenNoImp: 0,
      predictSolver: 0,
      predictManifoldOnly: 0,
      geomOverlapXZ: 0,
      geomDist3d: 0,
      v1Confirmed: 0,
      pairs: {} as Record<string, number[]>,
      // C. 正式采样盲区
      sampleEarly: 0,
      sampleEarlyCalcMismatch: 0,
      earlyWithManifold: 0,
      earlyWithSolver: 0,
      earlyReal: 0,
      earlyRealPairs: {} as Record<string, number>,
      earlyRealSegs: [] as number[],
      earlyRealEvents: [] as Record<string, unknown>[],
      sampledRealNoImpulse: 0,
      cfBusyNone: 0,
      cfIdleReal: 0,
      // 旧口径
      oldTouch: 0,
      oldTouchReal: 0,
      wobblingSteps: [0, 0, 0, 0],
    };
    let earlyRun = 0;
    // 牵引-运动直方图：`${tip}|${tstate}|${W/F}` → 速度分箱计数 + 接近步数
    const tm: Record<string, { n: number[]; closing: number; stepSum: number }> = {};
    const watch = WV.map(() => ({ cur: null as Ep | null, eps: [] as Record<string, unknown>[] }));
    const prevPos = beys.map((x) => ({ x: x.body.translation().x, z: x.body.translation().z }));
    const pathCum = [0, 0];
    const trig: Record<string, unknown>[] = [];
    let prevBO = 0;
    let prevWB = 0;
    let prevQ = b.contactQueries;
    let prevD = Math.hypot(A.body.translation().x - B.body.translation().x, A.body.translation().z - B.body.translation().z);
    const ratioHist: number[][] = [];
    let s = 0;
    // 每对证据（复用数组）
    const P = nA * nB;
    const pm = new Int32Array(P);
    const pnC = new Int32Array(P);
    const pnS = new Int32Array(P);
    const pminD = new Float64Array(P);
    const pminS = new Float64Array(P);
    const pimp = new Float64Array(P);
    const pnPos = new Int32Array(P);
    const pd3 = new Float64Array(P);
    for (; s < max && !b.result; s++) {
      pw.step();
      fingerprint(h, beys);
      const t = (s + 1) * PHYSICS_DT;
      // ── B. 接触证据向量 ──
      pm.fill(0);
      pnC.fill(0);
      pnS.fill(0);
      pminD.fill(Infinity);
      pminS.fill(Infinity);
      pimp.fill(0);
      pnPos.fill(0);
      pd3.fill(Infinity);
      for (let ia = 0; ia < nA; ia++)
        for (let ib = 0; ib < nB; ib++) {
          const k = ia * nB + ib;
          pw.world.contactPair(A.colliders[ia], B.colliders[ib], (m) => {
            pm[k]++;
            const n = m.numContacts();
            pnC[k] += n;
            for (let i = 0; i < n; i++) {
              pminD[k] = Math.min(pminD[k], m.contactDist(i));
              const j = m.contactImpulse(i);
              pimp[k] += j;
              if (j > 0) pnPos[k]++;
            }
            const ns = m.numSolverContacts();
            pnS[k] += ns;
            for (let i = 0; i < ns; i++) pminS[k] = Math.min(pminS[k], m.solverContactDist(i));
          });
        }
      const pa = A.body.translation();
      const pb = B.body.translation();
      const dXZ = Math.hypot(pa.x - pb.x, pa.z - pb.z);
      const bladeGap = dXZ - bladeSum;
      const outerGap = dXZ - outerSum;
      const overlapXZ = bladeGap < 0;
      const closing = (prevD - dXZ) / PHYSICS_DT;
      prevD = dXZ;
      let dist3d = Infinity;
      let dist3dBlade = Infinity;
      if (outerGap < 0.3) {
        for (let ia = 0; ia < nA; ia++)
          for (let ib = 0; ib < nB; ib++) {
            const c = A.colliders[ia].contactCollider(B.colliders[ib], 0.3);
            if (c) {
              pd3[ia * nB + ib] = c.distance;
              dist3d = Math.min(dist3d, c.distance);
            }
          }
        dist3dBlade = pd3[A.colliders.indexOf(A.bladeCollider) * nB + B.colliders.indexOf(B.bladeCollider)];
      }
      let manifolds = 0;
      let nC = 0;
      let nS = 0;
      let minDist = Infinity;
      let minSolver = Infinity;
      let imp = 0;
      let nPos = 0;
      const pairsReal: string[] = [];
      const pairsPredict: string[] = [];
      for (let k = 0; k < P; k++) {
        manifolds += pm[k];
        nC += pnC[k];
        nS += pnS[k];
        minDist = Math.min(minDist, pminD[k]);
        minSolver = Math.min(minSolver, pminS[k]);
        imp += pimp[k];
        nPos += pnPos[k];
        const name = pairName(Math.floor(k / nB), k % nB);
        const realK = (pnS[k] > 0 && pminS[k] <= 0) || pnPos[k] > 0;
        const predK = !realK && (pnC[k] > 0 || pnS[k] > 0);
        if (realK) pairsReal.push(name);
        else if (predK) pairsPredict.push(name);
        if (realK || predK || pd3[k] <= 0.01) {
          const e = (tally.pairs[name] ??= [0, 0, 0]);
          if (realK) e[2]++;
          else if (predK) e[1]++;
          else e[0]++;
        }
        if (wantSeries && (pm[k] > 0 || pd3[k] <= 0.01)) pairRows.push([r4(t), name, pnC[k], pnS[k], r5(pminD[k]), r5(pminS[k]), r5(pimp[k]), pnPos[k], r5(pd3[k])]);
      }
      const pen = nS > 0 && minSolver <= 0;
      const real = pen || nPos > 0;
      const predict = !real && (nC > 0 || nS > 0);
      const geom = !real && !predict && (dist3d <= 0.01 || overlapXZ);
      const cls = real ? 3 : predict ? 2 : geom ? 1 : 0;
      tally.steps++;
      tally.cls[cls]++;
      if (real) {
        if (pen && nPos > 0) tally.realPen++;
        else if (pen) tally.realPenNoImp++;
        else tally.realImpOnly++;
      }
      if (predict) nS > 0 ? tally.predictSolver++ : tally.predictManifoldOnly++;
      if (geom) overlapXZ ? tally.geomOverlapXZ++ : tally.geomDist3d++;
      if (nS > 0 && nPos > 0) tally.v1Confirmed++;
      // ── C. 正式采样提前返回 ──
      const early = b.contactQueries === prevQ;
      prevQ = b.contactQueries;
      const earlyCalc = dXZ > outerSum + 0.12;
      if (early !== earlyCalc) tally.sampleEarlyCalcMismatch++;
      if (early) {
        tally.sampleEarly++;
        if (nC > 0) tally.earlyWithManifold++;
        if (nS > 0) tally.earlyWithSolver++;
        if (real) {
          tally.earlyReal++;
          earlyRun++;
          for (const p of pairsReal) tally.earlyRealPairs[p] = (tally.earlyRealPairs[p] ?? 0) + 1;
          if (tally.earlyRealEvents.length < 400) tally.earlyRealEvents.push({ t: r4(t), pairs: pairsReal, tilt: beys.map((x) => r4(x.tilt)), outerGap: r4(outerGap), dXZ: r4(dXZ), minSolverDist: r5(minSolver), impulse: r5(imp), dist3d: r5(dist3d) });
        }
      }
      if (!(early && real) && earlyRun > 0) {
        tally.earlyRealSegs.push(earlyRun);
        earlyRun = 0;
      }
      if (!early && real && imp <= 0) tally.sampledRealNoImpulse++;
      const cfTouching = !early && imp > 0;
      const cfPhase = b.contact.state.phase;
      if (cfPhase !== 'idle' && cls === 0) tally.cfBusyNone++;
      if (cfPhase === 'idle' && real) tally.cfIdleReal++;
      const old = dXZ < bladeSum + 0.05;
      if (old) {
        tally.oldTouch++;
        if (real) tally.oldTouchReal++;
      }
      if (b.wobbleFor > 0) tally.wobblingSteps[cls]++;
      // ── 接触段 ──
      segDefs.forEach((d, k) => {
        const g = segs[k];
        if (d.on(cls)) {
          if (!g.on) {
            g.on = true;
            g.start = t;
            g.impCur = 0;
            if (g.lastOff >= 0 && t - g.lastOff < 0.25) g.flaps++;
          }
          g.miss = 0;
          g.impCur += imp;
        } else if (g.on) {
          g.miss++;
          if (g.miss > d.H) {
            g.on = false;
            g.lastOff = t;
            g.durs.push(r4(t - g.start - g.miss * PHYSICS_DT + PHYSICS_DT));
            g.imps.push(r5(g.impCur));
          }
        }
      });
      const inContact = segs[1].on;
      // ── A/D. 运动 ──
      const mv: Mv[] = beys.map((x, i) => {
        const p = x.body.translation();
        const v = x.body.linvel();
        const st = Math.hypot(p.x - prevPos[i].x, p.z - prevPos[i].z);
        prevPos[i] = { x: p.x, z: p.z };
        pathCum[i] += st;
        const pr = probes[i];
        const o = beys[1 - i].body.translation();
        const ol = Math.hypot(o.x - p.x, o.z - p.z) || 1;
        const ox = (o.x - p.x) / ol;
        const oz = (o.z - p.z) / ol;
        const hd = x.intent.heading;
        const sp = Math.hypot(v.x, v.z);
        const tstate: Mv['tstate'] = pr.applied ? 'applied' : !pr.gripOk ? 'gripLow' : !pr.eligible ? 'inelig' : pr.edgeOnly && !pr.edgeHelps ? 'edgeBlock' : !pr.capOk ? 'cap' : 'other';
        return {
          x: p.x,
          z: p.z,
          speed: sp,
          vx: v.x,
          vz: v.z,
          step: st,
          path: pathCum[i],
          spin: x.spin,
          ratio: x.spinRatio,
          tilt: x.tilt,
          r: Math.hypot(p.x, p.z),
          pr: { ...pr },
          tstate,
          dirVsIntent: deg(pr.dx * Math.cos(hd) + pr.dz * Math.sin(hd)),
          dirVsOpp: deg(pr.dx * ox + pr.dz * oz),
          velVsOpp: sp > 1e-4 ? deg((v.x * ox + v.z * oz) / sp) : NaN,
          headVsOpp: deg(Math.cos(hd) * ox + Math.sin(hd) * oz),
          intent: x.intent.state,
          auth: x.intent.authority,
          bo: x.breakout,
        };
      });
      ratioHist.push([A.spinRatio, B.spinRatio]);
      const geo = { dXZ, dist3d, bladeGap, outerGap, cls };
      // ── WATCH ──
      const watchOn = WV.map((V) => !inContact && mv[0].speed < V && mv[1].speed < V && mv[0].spin > SPIN_MIN && mv[1].spin > SPIN_MIN);
      // 牵引-运动直方图（双方转速 > SPIN_MIN 的步）
      if (mv[0].spin > SPIN_MIN && mv[1].spin > SPIN_MIN)
        mv.forEach((m, i) => {
          const key = `${beys[i].spec.tip.id}|${m.tstate}|${watchOn[1] ? 'W' : 'F'}`;
          const e = (tm[key] ??= { n: SPEED_BINS.map(() => 0), closing: 0, stepSum: 0 });
          e.n[SPEED_BINS.findIndex((x) => m.speed < x)]++;
          if (closing > 0.05) e.closing++;
          e.stepSum += m.step;
        });
      WV.forEach((V, k) => {
        const w = watch[k];
        if (watchOn[k]) {
          if (!w.cur) {
            w.cur = {
              t0: t,
              start: mv.map((m) => ({ x: m.x, z: m.z })),
              path: [0, 0],
              steps: 0,
              cls: [0, 0, 0, 0],
              overlap: 0,
              gapMin: Infinity,
              gapMax: -Infinity,
              d0: dXZ,
              dMin: dXZ,
              spin0: mv.map((m) => m.spin),
              ratio0: mv.map((m) => m.ratio),
              r0: mv.map((m) => m.r),
              rMax: [0, 0],
              speedSum: [0, 0],
              speedMax: [0, 0],
              ts: [0, 1].map(() => TSTATES.map(() => 0)),
              tiltMax: [0, 0],
              intents: {},
              authSum: [0, 0],
              dirVsIntentSum: [0, 0],
              dirVsOppSum: [0, 0],
              closingSum: 0,
              ck: [],
              cand: null,
            };
          }
          const c = w.cur;
          c.steps++;
          c.cls[cls]++;
          if (overlapXZ) c.overlap++;
          c.gapMin = Math.min(c.gapMin, bladeGap);
          c.gapMax = Math.max(c.gapMax, bladeGap);
          c.dMin = Math.min(c.dMin, dXZ);
          c.closingSum += closing;
          mv.forEach((m, i) => {
            c.path[i] += m.step;
            c.rMax[i] = Math.max(c.rMax[i], m.r);
            c.speedSum[i] += m.speed;
            c.speedMax[i] = Math.max(c.speedMax[i], m.speed);
            c.ts[i][TSTATES.indexOf(m.tstate)]++;
            c.tiltMax[i] = Math.max(c.tiltMax[i], m.tilt);
            const ik = `${i ? 'b' : 'a'}:${m.intent}`;
            c.intents[ik] = (c.intents[ik] ?? 0) + 1;
            c.authSum[i] += m.auth;
            c.dirVsIntentSum[i] += m.dirVsIntent;
            c.dirVsOppSum[i] += m.dirVsOpp;
          });
          const el = t - c.t0 + PHYSICS_DT;
          // 检查点：进入后第一次达到 1/2/3/5/10 s 的那一步，取真实位置
          const nextCk = CK[c.ck.length];
          if (nextCk !== undefined && el >= nextCk - 1e-9) {
            c.ck.push({
              at: nextCk,
              net: mv.map((m, i) => r4(Math.hypot(m.x - c.start[i].x, m.z - c.start[i].z))),
              path: c.path.map(r4),
              dXZ: r4(dXZ),
              bladeGap: r4(bladeGap),
              cls: [...c.cls],
              ts: c.ts.map((a) => [...a]),
              meanSpeed: c.speedSum.map((v) => r4(v / c.steps)),
              spin: mv.map((m) => r4(m.spin)),
            });
          }
          // E. 恢复候选快照：与 R1 相同触发点（WATCH(0.4) 持续 0.6 s）
          if (V === 0.4 && !c.cand && el >= 0.6 - 1e-9) c.cand = snapshot(t, mv, beys, geo);
        } else if (w.cur) {
          const why = inContact ? 'contact' : mv[0].spin <= SPIN_MIN || mv[1].spin <= SPIN_MIN ? 'spin' : 'speed';
          w.eps.push(closeEp(w.cur, t, why, mv, dXZ));
          w.cur = null;
        }
      });
      // ── F. wobble / 通用僵持触发现场 ──
      if (b.breakouts > prevBO) {
        const kind = b.wobbleBreaks > prevWB ? 'wobble' : 'stall';
        trig.push({
          kind,
          ...snapshot(t, mv, beys, geo),
          contact: { manifolds, nContacts: nC, nSolver: nS, minDist: r5(minDist), minSolverDist: r5(minSolver), impulse: r5(imp), nImpPos: nPos, pairsReal, pairsPredict, dist3dBlade: r5(dist3dBlade), overlapXZ, oldTouch: old },
          realH6: inContact,
          watch04: watchOn[1],
          r1On: [...r1On],
          stallFor: r4(b.stallFor),
          wobbleCool: r4(b.wobbleCool),
        });
        prevBO = b.breakouts;
        prevWB = b.wobbleBreaks;
      }
      // ── R1 对照（规则同 V1） ──
      if (r1) {
        r1WatchFor = watchOn[1] ? r1WatchFor + PHYSICS_DT : 0;
        const cand = needle.map((nd, i) => nd && !beys[i].dashing);
        if (!r1Cur && r1WatchFor > Number(process.env.R1_T ?? 0.6) && cand.some(Boolean)) {
          r1Cur = { t0: t, bey: cand.map((c) => (c ? 1 : 0)), moveT: null, reT: null, firstEvidT: null, path: [0, 0], spin0: mv.map((m) => m.spin), maxR: 0, wallNear: 0, wobbleBefore: b.wobbleBreaks, snap: snapshot(t, mv, beys, geo), dMin: dXZ };
          cand.forEach((c, i) => c && setR1(i, true));
        }
        if (r1Cur) {
          const c = r1Cur;
          c.dMin = Math.min(c.dMin, dXZ);
          mv.forEach((m) => {
            c.maxR = Math.max(c.maxR, m.r);
          });
          mv.forEach((m, i) => (c.path[i] += m.step));
          if (mv.some((m) => m.r > ARENA.radius - 0.6)) c.wallNear++;
          if (c.moveT === null && mv.some((m, i) => c.bey[i] && (m.speed > 0.4 || c.path[i] > 0.3))) c.moveT = t - c.t0;
          if (c.firstEvidT === null && cls >= 2) c.firstEvidT = t - c.t0;
          const close = (why: string) => {
            r1Acts.push({ t0: r4(c.t0), t1: r4(t), dur: r4(t - c.t0), end: why, bey: c.bey, moveT: c.moveT === null ? null : r4(c.moveT), reT: c.reT === null ? null : r4(c.reT), firstEvidT: c.firstEvidT === null ? null : r4(c.firstEvidT), path: c.path.map(r4), spinLoss: c.spin0.map((v, i) => r4(v - mv[i].spin)), maxR: r4(c.maxR), wallNearSteps: c.wallNear, wobbleDuring: b.wobbleBreaks - c.wobbleBefore, dMin: r4(c.dMin), start: c.snap });
            [0, 1].forEach((i) => setR1(i, false));
            r1Cur = null;
          };
          // V1 的撤销条件：确认接触（求解器接触且正冲量）
          if (nS > 0 && nPos > 0) {
            c.reT = t - c.t0;
            close('contact');
            r1WatchFor = 0;
          } else if (mv.some((m) => m.spin <= SPIN_MIN)) close('spin');
        }
      }
      // ── 输出行 ──
      track.push([r4(t), r4(mv[0].x), r4(mv[0].z), r4(mv[1].x), r4(mv[1].z), r4(mv[0].speed), r4(mv[1].speed), r4(mv[0].spin), r4(mv[1].spin), cls, nS, r5(minSolver), r5(imp), r5(dist3d), mv[0].pr.applied ? 1 : 0, mv[1].pr.applied ? 1 : 0, watchOn[1] ? 1 : 0]);
      if (wantSeries) {
        const row: (number | string)[] = [r4(t), CLS[cls], manifolds, nC, nS, r5(minDist), r5(minSolver), r5(imp), nPos, pairsReal.join('|'), pairsPredict.join('|'), r5(dist3d), r5(dist3dBlade), r4(dXZ), r4(outerGap), r4(bladeGap), overlapXZ ? 1 : 0, r4(closing), inContact ? 1 : 0, early ? 1 : 0, earlyCalc ? 1 : 0, cfTouching ? 1 : 0, cfPhase];
        mv.forEach((m, i) => row.push(r4(m.x), r4(m.z), r4(m.speed), r5(m.step), r4(m.path), r4(m.spin), r4(m.ratio), r4(m.tilt), r4(m.r), m.tstate, m.pr.eligible ? 1 : 0, m.pr.applied ? 1 : 0, m.pr.edgeOnly ? 1 : 0, m.pr.edgeHelps ? 1 : 0, m.pr.capOk ? 1 : 0, r4(m.pr.driveGrip), r4(m.pr.accel), r4(m.dirVsIntent), r4(m.dirVsOpp), r4(m.velVsOpp), m.intent, r4(m.auth), r4(m.bo), r1On[i] ? 1 : 0));
        row.push(r4(mv[0].spin / Math.max(1e-6, mv[1].spin)), watchOn[0] ? 1 : 0, watchOn[1] ? 1 : 0, watchOn[2] ? 1 : 0, r4(b.stallFor), r4(b.wobbleFor), b.breakouts, b.wobbleBreaks);
        series.push(row);
      }
    }
    const tEnd = s * PHYSICS_DT;
    const endMv = beys.map((x) => ({ x: x.body.translation().x, z: x.body.translation().z }));
    const endD = Math.hypot(endMv[0].x - endMv[1].x, endMv[0].z - endMv[1].z);
    WV.forEach((_, k) => {
      const w = watch[k];
      if (w.cur) w.eps.push(closeEp(w.cur, tEnd, 'end', endMv, endD));
    });
    if (earlyRun > 0) tally.earlyRealSegs.push(earlyRun);
    segs.forEach((g, k) => {
      if (g.on) {
        g.durs.push(r4(tEnd - g.start));
        g.imps.push(r5(g.impCur));
      }
      void k;
    });
    const res = b.result;
    const loser = res ? (res.loser === 'player' ? 0 : 1) : -1;
    const deathT0 = loser >= 0 ? (ratioHist.findIndex((r) => r[loser] < 0.2) + 1) * PHYSICS_DT : NaN;
    if (r1Cur) r1Acts.push({ t0: r4(r1Cur.t0), t1: r4(tEnd), dur: r4(tEnd - r1Cur.t0), end: 'end', bey: r1Cur.bey, moveT: r1Cur.moveT, reT: null, firstEvidT: r1Cur.firstEvidT, path: r1Cur.path.map(r4), maxR: r4(r1Cur.maxR), wallNearSteps: r1Cur.wallNear, wobbleDuring: b.wobbleBreaks - r1Cur.wobbleBefore, dMin: r4(r1Cur.dMin), start: r1Cur.snap });
    const tag = sc.name.replace(/[^\w.#-]+/g, '_').replace('#', '_');
    writeFileSync(join(outDir, 'track', `${tag}.csv.gz`), gzipSync([TRACK_COLS.join(','), ...track.map((r) => r.join(','))].join('\n')));
    if (wantSeries) {
      writeFileSync(join(outDir, 'series', `${tag}.csv.gz`), gzipSync([SERIES_COLS.join(','), ...series.map((r) => r.join(','))].join('\n')));
      writeFileSync(join(outDir, 'series', `${tag}.pairs.csv.gz`), gzipSync([PAIR_COLS.join(','), ...pairRows.map((r) => r.join(','))].join('\n')));
    }
    const summary = {
      name: sc.name,
      group: sc.group,
      seed: sc.seed,
      init: sc.init,
      tips: [baseSpec[0].tip.id, baseSpec[1].tip.id],
      blades: [baseSpec[0].blade.id, baseSpec[1].blade.id],
      launchSpin: beys.map((x) => r4((x as unknown as { launchSpin: number }).launchSpin)),
      result: res ? `${res.winner}:${res.finish}` : 'timeout',
      duration: r4(b.time),
      maxSeconds: sc.maxSeconds ?? 60,
      deathT0: r4(deathT0),
      hash: h.digest('hex'),
      steps: s,
      meta,
      tally,
      segs: segDefs.map((d, k) => ({ key: d.key, flaps: segs[k].flaps, durs: segs[k].durs, imps: segs[k].imps })),
      tm,
      watch: WV.map((V, k) => ({ V, eps: watch[k].eps.map((e) => ({ ...e, startInDeath: Number.isFinite(deathT0) && (e.t0 as number) >= deathT0 })) })),
      trig,
      breakouts: b.breakouts,
      wobbleBreaks: b.wobbleBreaks,
      r1: r1 ? { mode: r1, grip: r1 === 'a' ? Number(process.env.R1_GRIP ?? BEY_TUNING.breakoutGrip) : BEY_TUNING.edgeGrip, acts: r1Acts } : null,
    };
    pw.dispose();
    return summary;
  } finally {
    Math.random = orig;
  }
}

function closeEp(c: Ep, t: number, why: string, pos: { x: number; z: number }[], dXZ: number) {
  return {
    t0: r4(c.t0),
    t1: r4(t),
    dur: r4(t - c.t0),
    end: why,
    steps: c.steps,
    start: c.start.map((p) => [r4(p.x), r4(p.z)]),
    net: pos.map((p, i) => r4(Math.hypot(p.x - c.start[i].x, p.z - c.start[i].z))),
    path: c.path.map(r4),
    ck: c.ck,
    cls: c.cls,
    overlapFrac: r4(c.overlap / c.steps),
    gapMin: r4(c.gapMin),
    gapMax: r4(c.gapMax),
    d0: r4(c.d0),
    d1: r4(dXZ),
    dMin: r4(c.dMin),
    meanClosing: r4(c.closingSum / c.steps),
    spin0: c.spin0.map(r4),
    ratio0: c.ratio0.map(r4),
    spinAoverB0: r4(c.spin0[0] / Math.max(1e-6, c.spin0[1])),
    r0: c.r0.map(r4),
    rMax: c.rMax.map(r4),
    meanSpeed: c.speedSum.map((v) => r4(v / c.steps)),
    speedMax: c.speedMax.map(r4),
    ts: c.ts,
    tiltMax: c.tiltMax.map(r4),
    intents: c.intents,
    meanAuth: c.authSum.map((v) => r4(v / c.steps)),
    meanTractionVsIntentDeg: c.dirVsIntentSum.map((v) => r4(v / c.steps)),
    meanTractionVsOppDeg: c.dirVsOppSum.map((v) => r4(v / c.steps)),
    cand: c.cand,
  };
}

test('stall probe v2', async () => {
  const R = await loadRapier();
  const version = process.env.SP_VERSION ?? 'now';
  const outDir = process.env.SP_OUT ?? `test-results/stallprobe2/${version}`;
  mkdirSync(join(outDir, 'series'), { recursive: true });
  mkdirSync(join(outDir, 'track'), { recursive: true });
  const want = process.env.SP_GROUPS?.split(',') ?? null;
  const seriesNames = (process.env.SP_SERIES ?? '').split(',').filter(Boolean);
  const r1 = process.env.R1 ?? null;
  const runs: unknown[] = [];
  for (const sc of scenariosV2()) {
    if (want && !want.includes(sc.group)) continue;
    runs.push(await probeRun(R, sc, seriesNames.includes(sc.name) || seriesNames.includes(sc.group), r1, outDir));
  }
  const part = process.env.SP_PART ?? 'all';
  writeFileSync(join(outDir, `runs.${part}.json`), JSON.stringify({ version, tune: process.env.DIAG_TUNE ?? null, r1, r1T: process.env.R1_T ?? (r1 ? '0.6' : null), seriesCols: SERIES_COLS, trackCols: TRACK_COLS, pairCols: PAIR_COLS, runs }));
}, 7_200_000);
