/**
 * 低速停滞与自然接触：受控探针（只采集，不实现状态机，不改物理）。
 *
 * 每个物理步（120 Hz）分别采集、互不合并：
 *  1. Rapier 物理证据：两台全部碰撞体对（4×4）的 contact manifold 数、接触点数、求解器接触点数、
 *     最小 contactDist / solverContactDist、法向冲量和、正冲量点数
 *  2. 几何证据：XZ 中心距、外缘间隙、刀刃间隙、XZ 投影是否重叠；三维形状距离（Collider.contactCollider，
 *     最小值 + 刀刃对刀刃）——三维距离 ≤ 0 才是三维重叠
 *  3. 运动证据（每台）：水平速度、转速、本步位移、倾斜、牵引判定过程（BeyPhysics.probe，只写不读）、
 *     牵引方向与意图 heading 夹角、意图状态与 authority、breakout 倒计时
 *  4. 时间证据：按不同退出容忍（0/3/6/12 步）跟踪接触段；WATCH 候选段（未处于接触 + 双方低速 + 双方高转速）
 *     从进入时刻累计位移（路径长 + 净位移），不使用滑动窗口
 *
 * 只读：探针只调用 Rapier 查询（contactPair / contactCollider）与读取刚体状态；BeyPhysics.probe 只被写入。
 * 用 PROBE_VERIFY=1 每场再跑一遍不带探针的对照，逐步比较状态指纹，证明探针不改变物理。
 *
 * 环境变量：
 *   SP_OUT=目录（默认 test-results/stallprobe/<SP_VERSION>）  SP_VERSION=名字
 *   SP_GROUPS=AvD,...（默认全部 + FEELBAL/FEELSTA）  SP_SERIES=场景名,场景名（输出逐步 CSV）
 *   DIAG_TUNE='{"stallBreak":1}'（A 配置）
 *   R1=a|b  R1 grip-only 反事实（只在诊断进程里改实例的 tip 咬合，代码不变）：
 *     a = 针尖（咬合 < driveMinGrip）在 WATCH(V=R1_V) 持续 R1_T 秒后按 breakoutGrip 咬合，方向仍由进动决定，确认接触即撤销；
 *     （R1_GRIP 可改咬合值）
 *     b = 走现有 edgeOnly 代码路径（R1 生效时把意图 edgeW 抬到 0.5 → 咬合 edgeGrip 0.3，门控 / 上限 / 耗速全按原代码）
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'vitest';
import { ARENA } from '../../src/game/arena/arenaSpec';
import { createArenaPhysics } from '../../src/game/arena/ArenaPhysics';
import { BattleSystem } from '../../src/game/battle/BattleSystem';
import { BEY_TUNING, type BeyPhysics, type TractionProbe } from '../../src/game/beys/BeyPhysics';
import { assembleBey } from '../../src/game/beys/parts/assemble';
import type { BeyLoadout } from '../../src/game/beys/parts/types';
import { rivalCommand } from '../../src/game/launcher/launch';
import { loadRapier, PhysicsWorld, PHYSICS_DT } from '../../src/game/physics/PhysicsWorld';
import { seeded, type MotionScenario } from '../motion/motionSim';
import { groups } from '../motion/scenarios';

if (process.env.DIAG_TUNE) Object.assign(BEY_TUNING, JSON.parse(process.env.DIAG_TUNE));

type R = Awaited<ReturnType<typeof loadRapier>>;
const r4 = (x: number) => (Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : x);
const HYST = [0, 3, 6, 12];
const WV = [0.2, 0.4, 0.8];
const SPIN_MIN = 10;
/** 用于 WATCH 的接触状态退出容忍（步） */
const H_WATCH = 6;

interface Scn extends MotionScenario {
  group: string;
  feel?: boolean;
}

function scenarios(): Scn[] {
  const out: Scn[] = [];
  for (const g of groups()) for (const sc of g.scenarios) out.push({ ...sc, group: g.key });
  // physics.test「P2.3.1 不会长时间原地互转」用例的同一对阵与发射方式（feelRun），上限放宽到 120 s 观察是否结束
  const RIVAL: BeyLoadout = { blade: 'tidal-bastion', disc: 'hex-lock', tip: 'dome-ball' };
  const BAL: BeyLoadout = { blade: 'gale-crescent', disc: 'hex-lock', tip: 'dome-ball' };
  const STA: BeyLoadout = { blade: 'titan-crown', disc: 'hex-lock', tip: 'needle-point' };
  for (let i = 0; i < 6; i++) out.push({ name: `FEELBAL#${1000 + i}`, group: 'FEELBAL', player: BAL, rival: RIVAL, pCmd: { power: 0, aim: 0, tilt: 0 }, rCmd: { power: 0, aim: 0, tilt: 0 }, seed: 1000 + i, maxSeconds: 120, feel: true });
  for (let i = 0; i < 4; i++) out.push({ name: `FEELSTA#${3000 + i}`, group: 'FEELSTA', player: STA, rival: { ...STA, blade: 'tidal-bastion' }, pCmd: { power: 0, aim: 0, tilt: 0 }, rCmd: { power: 0, aim: 0, tilt: 0 }, seed: 3000 + i, maxSeconds: 120, feel: true });
  return out;
}

function setup(R: R, sc: Scn) {
  const pw = new PhysicsWorld(R);
  createArenaPhysics(pw);
  const b = new BattleSystem(pw, { player: assembleBey(sc.player), rival: assembleBey(sc.rival) });
  pw.beforeStep = (dt) => b.preStep(dt);
  pw.afterStep = (dt) => b.postStep(dt);
  let A: BeyPhysics;
  let B: BeyPhysics;
  if (sc.feel) {
    const rnd = Math.random;
    A = b.launch('player', { power: 0.6 + rnd() * 0.35, aim: (rnd() - 0.5) * 0.8, tilt: 0 });
    B = b.launch('rival', rivalCommand(rnd));
  } else {
    A = b.launch('player', sc.pCmd);
    B = b.launch('rival', sc.rCmd);
    if (sc.phase) {
      (A as unknown as { precession: number }).precession = sc.phase[0];
      (B as unknown as { precession: number }).precession = sc.phase[1];
    }
  }
  return { pw, b, A, B };
}

/** 状态指纹（逐步）：位置、姿态、速度、角速度、转速 */
function fingerprint(h: ReturnType<typeof createHash>, beys: BeyPhysics[]) {
  const f = new Float64Array(15 * beys.length);
  let k = 0;
  for (const x of beys) {
    const p = x.body.translation();
    const q = x.body.rotation();
    const v = x.body.linvel();
    const w = x.body.angvel();
    f.set([p.x, p.y, p.z, q.x, q.y, q.z, q.w, v.x, v.y, v.z, w.x, w.y, w.z, x.spin, x.tilt], k);
    k += 15;
  }
  h.update(Buffer.from(f.buffer));
}

/** 无探针对照：只跑物理，返回逐步指纹 */
async function plainRun(R: R, sc: Scn): Promise<{ hash: string; steps: number; result: string }> {
  const orig = Math.random;
  Math.random = seeded(sc.seed);
  try {
    const { pw, b, A, B } = setup(R, sc);
    const h = createHash('sha256');
    const max = (sc.maxSeconds ?? 60) / PHYSICS_DT;
    let s = 0;
    for (; s < max && !b.result; s++) {
      pw.step();
      fingerprint(h, [A, B]);
    }
    const out = { hash: h.digest('hex'), steps: s, result: b.result ? `${b.result.winner}:${b.result.finish}` : 'timeout' };
    pw.dispose();
    return out;
  } finally {
    Math.random = orig;
  }
}

const SERIES_COLS = [
  't', 'manifolds', 'nContacts', 'nSolver', 'minDist', 'minSolverDist', 'impulse', 'nImpPos', 'dist3d', 'dist3dBlade',
  'dXZ', 'outerGap', 'bladeGap', 'overlapXZ', 'evidence', 'cState0', 'cState6', 'cfPhase',
  ...['a', 'b'].flatMap((s) => [`${s}Speed`, `${s}Spin`, `${s}Ratio`, `${s}Step`, `${s}Tilt`, `${s}R`, `${s}Eligible`, `${s}Applied`, `${s}EdgeOnly`, `${s}EdgeHelps`, `${s}CapOk`, `${s}DriveGrip`, `${s}Accel`, `${s}DirVsIntentDeg`, `${s}Intent`, `${s}Authority`, `${s}Breakout`, `${s}R1`]),
  'watch02', 'watch04', 'watch08', 'stallFor', 'wobbleFor', 'breakouts', 'wobbleBreaks',
];

async function probeRun(R: R, sc: Scn, wantSeries: boolean, r1: string | null) {
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
    const series: (number | string)[][] = [];

    // ── R1 反事实（诊断进程内） ──
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
      // 走现有 edgeOnly 代码路径：R1 生效时把意图的 edgeW 至少设为 0.5（edgeW 只用于借咬合），
      // 牵引咬合 = edgeGrip × 1 = 0.3，edgeOnly 门控、速度上限、转速消耗全部按原代码执行
      beys.forEach((x, i) => {
        const it = x.intent as unknown as { update: (inp: unknown) => void; edgeW: number };
        const raw = it.update.bind(it);
        it.update = (inp) => {
          raw(inp);
          if (r1On[i] && it.edgeW < 0.5) {
            it.edgeW = 0.5;
            r1Dropped[i]++;
          }
        };
      });
    }
    const r1Dropped = [0, 0];
    const r1Steps = [0, 0];
    let r1WatchFor = 0;
    const r1Acts: Record<string, unknown>[] = [];
    let r1Cur: { t0: number; bey: number[]; moveT: number | null; reT: number | null; path: number[]; spin0: number[]; maxR: number; wallNear: number; wobbleBefore: number; firstEvidT: number | null } | null = null;

    // ── 接触状态（多种退出容忍） ──
    const cState = HYST.map(() => ({ on: false, miss: 0, segs: 0, flaps: 0, lastOff: -1, curStart: 0, durs: [] as number[] }));
    // ── WATCH 候选段 ──
    type W = { t0: number; path: number[]; start: { x: number; z: number }[]; steps: number; uncertain: number; overlap: number; gapMin: number; gapMax: number; spin0: number[]; ratioMin: number[]; applied: number[]; eligible: number[]; gateOk: number[]; tiltMax: number[]; intents: Record<string, number> };
    const watch = WV.map(() => ({ cur: null as W | null, eps: [] as Record<string, unknown>[] }));
    const prevPos = beys.map((x) => ({ x: x.body.translation().x, z: x.body.translation().z }));
    // 每场汇总
    const tally = { steps: 0, confirmed: 0, weak: 0, none: 0, overlapNoContact: 0, contactNoOverlap: 0, manifoldNoSolver: 0, solverNoImpulse: 0, impulseNoSolver: 0, cfBusyNoContact: 0, cfIdleConfirmed: 0, deathSteps: 0, oldTouch: 0, oldTouchConfirmed: 0, oldTouchWeak: 0, oldLongest: 0, physLongestH6: 0, pairs: {} as Record<string, number> };
    let oldCur = 0;
    const CN = ['ball', 'shaft', 'disc', 'blade'];
    const stallTrig: Record<string, unknown>[] = [];
    let prevBO = 0;
    let prevWB = 0;
    let s = 0;
    const ratioHist: number[][] = [];
    for (; s < max && !b.result; s++) {
      pw.step();
      fingerprint(h, beys);
      const t = (s + 1) * PHYSICS_DT;
      // 1) Rapier 证据
      let manifolds = 0;
      let nC = 0;
      let nS = 0;
      let minDist = Infinity;
      let minSolver = Infinity;
      let imp = 0;
      let nPos = 0;
      const pairHit: string[] = [];
      for (let ia = 0; ia < A.colliders.length; ia++)
        for (let ib = 0; ib < B.colliders.length; ib++)
          pw.world.contactPair(A.colliders[ia], B.colliders[ib], (m) => {
            manifolds++;
            let pos = false;
            for (let i = 0; i < m.numContacts(); i++) if (m.contactImpulse(i) > 0) pos = true;
            if (pos && m.numSolverContacts() > 0) pairHit.push(`${CN[ia] ?? ia}-${CN[ib] ?? ib}`);
            const n = m.numContacts();
            nC += n;
            for (let i = 0; i < n; i++) {
              minDist = Math.min(minDist, m.contactDist(i));
              const j = m.contactImpulse(i);
              imp += j;
              if (j > 0) nPos++;
            }
            const ns = m.numSolverContacts();
            nS += ns;
            for (let i = 0; i < ns; i++) minSolver = Math.min(minSolver, m.solverContactDist(i));
          });
      // 2) 几何证据
      const pa = A.body.translation();
      const pb = B.body.translation();
      const dXZ = Math.hypot(pa.x - pb.x, pa.z - pb.z);
      const bladeGap = dXZ - bladeSum;
      const outerGap = dXZ - outerSum;
      const overlapXZ = bladeGap < 0;
      let dist3d = Infinity;
      let dist3dBlade = Infinity;
      if (outerGap < 0.3) {
        for (const ca of A.colliders)
          for (const cb of B.colliders) {
            const c = ca.contactCollider(cb, 0.3);
            if (c) dist3d = Math.min(dist3d, c.distance);
          }
        const c = A.bladeCollider.contactCollider(B.bladeCollider, 0.3);
        if (c) dist3dBlade = c.distance;
      }
      // 证据分级（数据组织用，不是最终阈值）：confirmed = 求解器接触点且有正冲量；weak = 有接触点 / 三维距离 ≤ 2 mm 但未确认
      const confirmed = nS > 0 && nPos > 0;
      const weak = !confirmed && ((nC > 0 && minDist <= 0.002) || dist3d <= 0.002);
      const evidence = confirmed ? 2 : weak ? 1 : 0;
      for (const k of pairHit) tally.pairs[k] = (tally.pairs[k] ?? 0) + 1;
      // 历史口径（前几轮报告的“接触”）：XZ 中心距 < 刀刃半径和 + 0.05
      const old = dXZ < bladeSum + 0.05;
      oldCur = old ? oldCur + PHYSICS_DT : 0;
      tally.oldLongest = Math.max(tally.oldLongest, oldCur);
      if (old) {
        tally.oldTouch++;
        if (confirmed) tally.oldTouchConfirmed++;
        else if (weak) tally.oldTouchWeak++;
      }
      tally.steps++;
      if (confirmed) tally.confirmed++;
      else if (weak) tally.weak++;
      else tally.none++;
      if (overlapXZ && !confirmed && !weak) tally.overlapNoContact++;
      if (confirmed && !overlapXZ) tally.contactNoOverlap++;
      if (nC > 0 && nS === 0) tally.manifoldNoSolver++;
      if (nS > 0 && nPos === 0) tally.solverNoImpulse++;
      if (nPos > 0 && nS === 0) tally.impulseNoSolver++;
      const cfPhase = b.contact.state.phase;
      if (cfPhase !== 'idle' && evidence === 0) tally.cfBusyNoContact++;
      if (cfPhase === 'idle' && confirmed) tally.cfIdleConfirmed++;
      // 接触状态：进入 = confirmed；退出 = 连续 H 步没有 confirmed
      HYST.forEach((H, k) => {
        const c = cState[k];
        if (confirmed) {
          if (!c.on) {
            c.on = true;
            c.segs++;
            c.curStart = t;
            if (c.lastOff >= 0 && t - c.lastOff < 0.25) c.flaps++;
          }
          c.miss = 0;
        } else if (c.on) {
          c.miss++;
          if (c.miss > H) {
            c.on = false;
            c.lastOff = t;
            c.durs.push(t - c.curStart - c.miss * PHYSICS_DT);
          }
        }
      });
      const inContact = cState[HYST.indexOf(H_WATCH)].on;
      // 3) 运动证据
      const mv = beys.map((x, i) => {
        const p = x.body.translation();
        const v = x.body.linvel();
        const st = Math.hypot(p.x - prevPos[i].x, p.z - prevPos[i].z);
        prevPos[i] = { x: p.x, z: p.z };
        const pr = probes[i];
        const hd = x.intent.heading;
        const dirDeg = (Math.acos(Math.max(-1, Math.min(1, pr.dx * Math.cos(hd) + pr.dz * Math.sin(hd)))) * 180) / Math.PI;
        return { speed: Math.hypot(v.x, v.z), spin: x.spin, ratio: x.spinRatio, step: st, tilt: x.tilt, r: Math.hypot(p.x, p.z), pr: { ...pr }, dirDeg, gateOk: pr.dx * Math.cos(hd) + pr.dz * Math.sin(hd) > 0, intent: x.intent.state, auth: x.intent.authority, bo: x.breakout };
      });
      ratioHist.push([A.spinRatio, B.spinRatio]);
      // 4) WATCH 候选段（数据组织：真实接触优先 → 未处于接触 + 双方低速 + 双方高转速）
      const watchOn = WV.map((V) => !inContact && mv[0].speed < V && mv[1].speed < V && mv[0].spin > SPIN_MIN && mv[1].spin > SPIN_MIN);
      WV.forEach((V, k) => {
        const w = watch[k];
        if (watchOn[k]) {
          if (!w.cur) {
            w.cur = { t0: t, path: [0, 0], start: beys.map((x) => ({ x: x.body.translation().x, z: x.body.translation().z })), steps: 0, uncertain: 0, overlap: 0, gapMin: Infinity, gapMax: -Infinity, spin0: mv.map((m) => m.spin), ratioMin: [1, 1], applied: [0, 0], eligible: [0, 0], gateOk: [0, 0], tiltMax: [0, 0], intents: {} };
          }
          const c = w.cur;
          c.steps++;
          if (evidence === 1) c.uncertain++;
          if (overlapXZ) c.overlap++;
          c.gapMin = Math.min(c.gapMin, bladeGap);
          c.gapMax = Math.max(c.gapMax, bladeGap);
          mv.forEach((m, i) => {
            c.path[i] += m.step;
            c.ratioMin[i] = Math.min(c.ratioMin[i], m.ratio);
            if (m.pr.applied) c.applied[i]++;
            if (m.pr.eligible) c.eligible[i]++;
            if (m.gateOk) c.gateOk[i]++;
            c.tiltMax[i] = Math.max(c.tiltMax[i], m.tilt);
            c.intents[`${i ? 'b' : 'a'}:${m.intent}`] = (c.intents[`${i ? 'b' : 'a'}:${m.intent}`] ?? 0) + 1;
          });
        } else if (w.cur) {
          const c = w.cur;
          const why = inContact ? 'contact' : mv[0].spin <= SPIN_MIN || mv[1].spin <= SPIN_MIN ? 'spin' : 'speed';
          w.eps.push(closeWatch(c, t, why, beys));
          w.cur = null;
        }
      });
      // A 配置：通用僵持触发时的证据分类
      if (b.breakouts > prevBO) {
        stallTrig.push({ t: r4(t), kind: b.wobbleBreaks > prevWB ? 'wobble' : 'stall', evidence, overlapXZ, bladeGap: r4(bladeGap), dist3d: r4(dist3d), inContact, watch04: watchOn[1] });
        prevBO = b.breakouts;
        prevWB = b.wobbleBreaks;
      }
      // R1 反事实
      if (r1) {
        r1WatchFor = watchOn[1] ? r1WatchFor + PHYSICS_DT : 0;
        const cand = needle.map((nd, i) => nd && !beys[i].dashing);
        if (!r1Cur && r1WatchFor > Number(process.env.R1_T ?? 0.6) && cand.some(Boolean)) {
          r1Cur = { t0: t, bey: cand.map((c) => (c ? 1 : 0)), moveT: null, reT: null, path: [0, 0], spin0: mv.map((m) => m.spin), maxR: 0, wallNear: 0, wobbleBefore: b.wobbleBreaks, firstEvidT: null };
          cand.forEach((c, i) => c && setR1(i, true));
        }
        if (r1Cur) {
          const c = r1Cur;
          mv.forEach((m, i) => {
            c.path[i] += m.step;
            c.maxR = Math.max(c.maxR, m.r);
            if (r1On[i]) r1Steps[i]++;
          });
          if (mv.some((m) => m.r > ARENA.radius - 0.6)) c.wallNear++;
          if (c.moveT === null && mv.some((m, i) => c.bey[i] && (m.speed > 0.4 || c.path[i] > 0.3))) c.moveT = t - c.t0;
          if (c.firstEvidT === null && evidence > 0) c.firstEvidT = t - c.t0;
          if (confirmed) {
            c.reT = t - c.t0;
            r1Acts.push(closeR1(c, t, 'contact', mv, b.wobbleBreaks));
            [0, 1].forEach((i) => setR1(i, false));
            r1Cur = null;
            r1WatchFor = 0;
          } else if (mv.some((m) => m.spin <= SPIN_MIN)) {
            r1Acts.push(closeR1(c, t, 'spin', mv, b.wobbleBreaks));
            [0, 1].forEach((i) => setR1(i, false));
            r1Cur = null;
          }
        }
      }
      if (wantSeries) {
        const row: (number | string)[] = [r4(t), manifolds, nC, nS, r4(minDist), r4(minSolver), r4(imp), nPos, r4(dist3d), r4(dist3dBlade), r4(dXZ), r4(outerGap), r4(bladeGap), overlapXZ ? 1 : 0, evidence, cState[0].on ? 1 : 0, inContact ? 1 : 0, cfPhase];
        mv.forEach((m, i) => row.push(r4(m.speed), r4(m.spin), r4(m.ratio), r4(m.step), r4(m.tilt), r4(m.r), m.pr.eligible ? 1 : 0, m.pr.applied ? 1 : 0, m.pr.edgeOnly ? 1 : 0, m.pr.edgeHelps ? 1 : 0, m.pr.capOk ? 1 : 0, r4(m.pr.driveGrip), r4(m.pr.accel), r4(m.dirDeg), m.intent, r4(m.auth), r4(m.bo), r1On[i] ? 1 : 0));
        row.push(watchOn[0] ? 1 : 0, watchOn[1] ? 1 : 0, watchOn[2] ? 1 : 0, r4(b.stallFor), r4(b.wobbleFor), b.breakouts, b.wobbleBreaks);
        series.push(row);
      }
    }
    const tEnd = s * PHYSICS_DT;
    WV.forEach((_, k) => {
      const w = watch[k];
      if (w.cur) w.eps.push(closeWatch(w.cur, tEnd, 'end', beys));
    });
    if (r1Cur) r1Acts.push(closeR1(r1Cur, tEnd, 'end', beys.map((x) => ({ spin: x.spin })), b.wobbleBreaks));
    cState.forEach((c) => c.on && c.durs.push(tEnd - c.curStart));
    tally.physLongestH6 = Math.max(0, ...cState[HYST.indexOf(H_WATCH)].durs);
    // 死亡阶段：输家转速比例首次 < 0.2 起
    const res = b.result;
    const loser = res ? (res.loser === 'player' ? 0 : 1) : -1;
    const deathT0 = loser >= 0 ? (ratioHist.findIndex((r) => r[loser] < 0.2) + 1) * PHYSICS_DT : NaN;
    const summary = {
      name: sc.name,
      group: sc.group,
      seed: sc.seed,
      tips: [A.spec.tip.id ?? baseSpec[0].tip.id, B.spec.tip.id ?? baseSpec[1].tip.id],
      result: res ? `${res.winner}:${res.finish}` : 'timeout',
      duration: r4(b.time),
      maxSeconds: sc.maxSeconds ?? 60,
      forced120: !!res && b.time > 120,
      deathT0: r4(deathT0),
      hash: h.digest('hex'),
      steps: s,
      tally,
      contactHyst: HYST.map((H, k) => {
        const d = cState[k].durs.sort((x, y) => x - y);
        return { H, segs: cState[k].segs, flaps: cState[k].flaps, p50: r4(d[Math.floor(d.length / 2)] ?? 0), p90: r4(d[Math.floor(d.length * 0.9)] ?? 0), max: r4(d[d.length - 1] ?? 0), total: r4(d.reduce((x, y) => x + y, 0)) };
      }),
      watch: WV.map((V, k) => ({ V, eps: watch[k].eps.map((e) => ({ ...e, startInDeath: Number.isFinite(deathT0) && (e.t0 as number) >= deathT0, deathOverlap: Number.isFinite(deathT0) ? r4(Math.max(0, (e.t1 as number) - Math.max(deathT0, e.t0 as number)) / (e.dur as number)) : 0 })) })),
      stallTrig,
      breakouts: b.breakouts,
      wobbleBreaks: b.wobbleBreaks,
      r1: r1 ? { mode: r1, grip: r1 === 'a' ? Number(process.env.R1_GRIP ?? BEY_TUNING.breakoutGrip) : BEY_TUNING.edgeGrip, acts: r1Acts, edgeWSet: r1Dropped, r1Steps } : null,
    };
    pw.dispose();
    return { summary, series };
  } finally {
    Math.random = orig;
  }
}

function closeWatch(c: { t0: number; path: number[]; start: { x: number; z: number }[]; steps: number; uncertain: number; overlap: number; gapMin: number; gapMax: number; spin0: number[]; ratioMin: number[]; applied: number[]; eligible: number[]; gateOk: number[]; tiltMax: number[]; intents: Record<string, number> }, t: number, why: string, beys: BeyPhysics[]) {
  const net = beys.map((x, i) => Math.hypot(x.body.translation().x - c.start[i].x, x.body.translation().z - c.start[i].z));
  return {
    t0: r4(c.t0),
    t1: r4(t),
    dur: r4(t - c.t0),
    end: why,
    path: c.path.map(r4),
    net: net.map(r4),
    uncertainFrac: r4(c.uncertain / c.steps),
    overlapFrac: r4(c.overlap / c.steps),
    gapMin: r4(c.gapMin),
    gapMax: r4(c.gapMax),
    spin0: c.spin0.map(r4),
    spin1: beys.map((x) => r4(x.spin)),
    ratioMin: c.ratioMin.map(r4),
    appliedFrac: c.applied.map((v) => r4(v / c.steps)),
    eligibleFrac: c.eligible.map((v) => r4(v / c.steps)),
    gateOkFrac: c.gateOk.map((v) => r4(v / c.steps)),
    tiltMax: c.tiltMax.map(r4),
    intents: c.intents,
  };
}

function closeR1(c: { t0: number; bey: number[]; moveT: number | null; reT: number | null; path: number[]; spin0: number[]; maxR: number; wallNear: number; wobbleBefore: number; firstEvidT: number | null }, t: number, why: string, mv: { spin: number }[], wobbleNow: number) {
  return { t0: r4(c.t0), t1: r4(t), dur: r4(t - c.t0), end: why, bey: c.bey, moveT: c.moveT === null ? null : r4(c.moveT), reT: c.reT === null ? null : r4(c.reT), firstEvidT: c.firstEvidT === null ? null : r4(c.firstEvidT), path: c.path.map(r4), spinLoss: c.spin0.map((v, i) => r4(v - mv[i].spin)), maxR: r4(c.maxR), wallNearSteps: c.wallNear, wobbleDuring: wobbleNow - c.wobbleBefore };
}

test('stall probe', async () => {
  const R = await loadRapier();
  const version = process.env.SP_VERSION ?? 'now';
  const outDir = process.env.SP_OUT ?? `test-results/stallprobe/${version}`;
  mkdirSync(join(outDir, 'series'), { recursive: true });
  const want = process.env.SP_GROUPS?.split(',') ?? null;
  const seriesNames = (process.env.SP_SERIES ?? '').split(',').filter(Boolean);
  const r1 = process.env.R1 ?? null;
  const verify = process.env.PROBE_VERIFY === '1';
  const runs: unknown[] = [];
  const verifyOut: unknown[] = [];
  for (const sc of scenarios()) {
    if (want && !want.includes(sc.group)) continue;
    const { summary, series } = await probeRun(R, sc, seriesNames.includes(sc.name), r1);
    runs.push(summary);
    if (series.length) writeFileSync(join(outDir, 'series', `${sc.name.replace(/[^\w.#-]+/g, '_').replace('#', '_')}.csv`), [SERIES_COLS.join(','), ...series.map((r) => r.join(','))].join('\n'));
    if (verify) {
      const p = await plainRun(R, sc);
      verifyOut.push({ name: sc.name, probeHash: summary.hash, plainHash: p.hash, same: p.hash === summary.hash && p.steps === summary.steps, steps: [summary.steps, p.steps], result: [summary.result, p.result] });
    }
  }
  writeFileSync(join(outDir, 'runs.json'), JSON.stringify({ version, tune: process.env.DIAG_TUNE ?? null, r1, r1T: process.env.R1_T ?? (r1 ? '0.6' : null), seriesCols: SERIES_COLS, runs }));
  if (verify) writeFileSync(join(outDir, 'verify.json'), JSON.stringify(verifyOut, null, 1));
}, 3_600_000);
