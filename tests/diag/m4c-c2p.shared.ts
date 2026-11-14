/// <reference types="node" />
/**
 * M4-C · C2-P 姿态刚度预算实验的运行器（docs/engineering/m4c-c2-preregistration.md，冻结于 1aab164）。
 *
 * 一个臂、一个集合（S1 或 S4）一次运行：
 *  - 对战：matrixScenarios(20000, 20)（S1）或 matrixScenarios(60000, 40)（S4 的对战部分）；每回合一行（§7.1 的“场景行”）；
 *  - S2：M4-A 单台套件 soloSuite（36 台）；S3：撞后恢复探针 48 台（4 签名 × 转速比例 {0.9, 0.6, 0.4, 0.25} × 3 方位，种子 95000 + 100·si + 10·ri + k）；
 *  - 全部内容同种子运行两次，逐步状态哈希与逐行结果比较（P6 确定性）；
 *  - 只读测量：EXECUTOR_PROBE（M1 刚度 / 阻尼 / 合成、λ、M7 相位差、姿态正功）、ContactService（M6 接地类别 A/B/C/D）、Trace（E1–E5、M2–M4）。
 * 唯一的行为变化来自 POSTURE_BUDGET（§3.2）；S3 的扰动只在本诊断脚本里施加（§6.1），不进入游戏。
 * 记号：输出里的数值不舍入（§7.3：门槛比较用未舍入的值）；r2 / r3 只用于与现有 analyzeRound 输出做一致性核对。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import type RAPIER from '@dimforge/rapier3d-compat';
import { ARENA, floorHeight } from '../../src/game/arena/arenaSpec';
import { createArenaPhysics, TABLE_Y } from '../../src/game/arena/ArenaPhysics';
import { FINISH_TUNING } from '../../src/game/battle/BattleSystem';
import { BEY_TUNING, BeyPhysics, type SpinLedger } from '../../src/game/beys/BeyPhysics';
import { EXECUTOR_PROBE, POSTURE_BUDGET, type ExecutorHost, type ExecutorProbe, type ExecFrame } from '../../src/game/beys/motionExecutor';
import { assembleBey } from '../../src/game/beys/parts/assemble';
import { BITS, SIGNATURE_LIST } from '../../src/game/beys/parts/catalog';
import { computeLaunch } from '../../src/game/launcher/launch';
import { BEY_COLLIDER_PARTS, type ContactService } from '../../src/game/physics/ContactService';
import { PhysicsWorld, PHYSICS_DT } from '../../src/game/physics/PhysicsWorld';
import { seeded } from '../motion/motionSim';
import { analyzeRound, baseTilt, C, episodes as epsOf, findFloor, freeMask, r2, r3, steps, Trace, type FinishInfo, type RoundMetrics } from './m4.metrics';
import { POW, soloSuite, type R } from './m4.runs';
import { matrixScenarios, runRound, summarize, type RoundRec } from './m5b.shared';

const DT = PHYSICS_DT;
const T = BEY_TUNING;
export const KEYS: string[] = SIGNATURE_LIST.map((s) => s.key);
export const GROUP: Record<string, 'A' | 'D'> = { lieren: 'A', senheng: 'A', pandun: 'D', ziyao: 'D' };

/** §4 的四个实验臂 */
export const ARMS = {
  P0: { on: 0, kRef: 0 },
  Pa: { on: 1, kRef: 0.2 },
  Pb: { on: 1, kRef: 0.6 },
  Pc: { on: 1, kRef: 1.2 },
} as const;
export type ArmName = keyof typeof ARMS;
export const ARM_NAMES = Object.keys(ARMS) as ArmName[];

export function withArm<X>(arm: ArmName, fn: () => X): X {
  const old = { ...POSTURE_BUDGET };
  Object.assign(POSTURE_BUDGET, ARMS[arm]);
  try {
    return fn();
  } finally {
    Object.assign(POSTURE_BUDGET, old);
  }
}

/** §6.1 的集合 */
export const SETS = {
  S1: { base: 20000, seeds: 20 },
  S4: { base: 60000, seeds: 40 },
} as const;
export type SetName = keyof typeof SETS;

export const S3_RATIOS = [0.9, 0.6, 0.4, 0.25];
export const S3_POWER = 0.8;
/** 接地类别（§6.3）：A = 只有接地球；B = 轴杆参与；C = 棘轮 / 刀刃触地；D = 离地。同一步多类时按 B > C > A > D 归类 */
export const CLS = ['A', 'B', 'C', 'D'] as const;

// ───────────────────────────── 逐步状态哈希 ─────────────────────────────

/** 物理审计（P6）：非数值，或在场地半径内落到地面以下 0.5 u（与 runRound 的 bad 同一定义），按运行累计 */
export const AUDIT = { bad: 0 };

class Hasher {
  h = 0x811c9dc5;
  private f = new Float64Array(1);
  private u = new Uint32Array(this.f.buffer);
  add(x: number) {
    this.f[0] = x;
    this.h = Math.imul(this.h ^ this.u[0], 0x01000193) >>> 0;
    this.h = Math.imul(this.h ^ this.u[1], 0x01000193) >>> 0;
  }
  bey(b: BeyPhysics) {
    const p = b.body.translation();
    const q = b.body.rotation();
    const v = b.body.linvel();
    const w = b.body.angvel();
    for (const x of [p.x, p.y, p.z, q.x, q.y, q.z, q.w, v.x, v.y, v.z, w.x, w.y, w.z, b.spin, b.precession]) this.add(x);
    const r = Math.hypot(p.x, p.z);
    if (!Number.isFinite(Math.hypot(v.x, v.z)) || !Number.isFinite(p.y) || !Number.isFinite(b.spin) || (r < ARENA.radius && p.y < floorHeight(r) - 0.5)) AUDIT.bad++;
  }
}

// ───────────────────────────── 汇总容器 ─────────────────────────────

export class Agg {
  readonly d: Record<string, number[]> = {};
  readonly c: Record<string, number> = {};
  push(name: string, v: number) {
    if (Number.isFinite(v)) (this.d[name] ??= []).push(v);
  }
  inc(name: string, k = 1) {
    this.c[name] = (this.c[name] ?? 0) + k;
  }
}

export function quant(a: number[]) {
  if (!a.length) return { n: 0 };
  const s = Float64Array.from(a).sort();
  const q = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
  let sum = 0;
  for (const v of s) sum += v;
  return { n: s.length, p10: q(0.1), p25: q(0.25), p50: q(0.5), p75: q(0.75), p90: q(0.9), p99: q(0.99), mean: sum / s.length, max: s[s.length - 1] };
}

const band = (ratio: number) => (ratio >= 0.6 ? 'hi' : ratio >= 0.3 ? 'mid' : 'lo');
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);

// ───────────────────────────── 每台的只读跟踪 ─────────────────────────────

const LEDGER_KEYS: (keyof SpinLedger)[] = ['base', 'scrape', 'rail', 'drive', 'steer', 'burst', 'air', 'smash', 'claw', 'contactLoss', 'contactGain'];

class Track {
  /** 发射过渡之后才计入（对战：意图离开 launch；单台：发射后 1 s） */
  active = false;
  k = 0;
  WpdPos = 0;
  pdSteps = 0;
  truncSteps = 0;
  probeMismatch = 0;
  readonly Ia: number;
  readonly It: number;
  readonly w0: number;
  readonly E0: number;
  prevLedger: Record<string, number> = {};
  prevSpin: number;
  bStart = -1;
  constructor(
    readonly key: string,
    readonly side: string,
    readonly bey: BeyPhysics,
    readonly A: Agg,
    readonly collect: boolean,
  ) {
    this.Ia = bey.spec.spinInertia;
    this.It = bey.massProps.It;
    this.w0 = bey.launchSpin;
    this.E0 = 0.5 * this.Ia * this.w0 * this.w0;
    this.prevSpin = bey.spin;
    for (const kk of LEDGER_KEYS) this.prevLedger[kk] = bey.ledger[kk];
  }
}

const tracks = new Map<ExecutorHost, Track>();

/** 只读探针（§7 M1、M7、姿态正功）：只读数值，不调用 Rapier，不写宿主 / ExecFrame */
const PROBE: ExecutorProbe = {
  rail: () => undefined,
  traction: () => undefined,
  rolling: () => undefined,
  posture(h, f: ExecFrame, s, _lean, px0, py0, pz0, sx, sz, lam) {
    const t = tracks.get(h);
    if (!t || !t.active || h.bursted) return;
    if (!(s > 0)) return;
    const cd = T.uprightDamping;
    const ax = lam * sx - cd * s * px0;
    const ay = -cd * s * py0;
    const az = lam * sz - cd * s * pz0;
    const dpx = f.px - px0;
    const dpy = f.py - py0;
    const dpz = f.pz - pz0;
    // 测量自检：探针报告的 α 与实际施加的横向角速度变化一致（§8.5“测量误差”）
    if (Math.abs(dpx / f.dt - ax) > 1e-6 * (1 + Math.abs(ax)) || Math.abs(dpz / f.dt - az) > 1e-6 * (1 + Math.abs(az)) || Math.abs(dpy / f.dt - ay) > 1e-6 * (1 + Math.abs(ay))) t.probeMismatch++;
    t.pdSteps++;
    if (lam < 1) t.truncSteps++;
    const dKE = t.It * (px0 * dpx + py0 * dpy + pz0 * dpz + 0.5 * (dpx * dpx + dpy * dpy + dpz * dpz));
    if (dKE > 0) t.WpdPos += dKE;
    if (!t.collect) return;
    const A = t.A;
    const b = band(Math.min(1, f.mag / h.launchSpin));
    const pre = `${t.key}|${b}`;
    A.inc(`${pre}|pd`);
    if (lam < 1) A.inc(`${pre}|trunc`);
    if (t.k % 2 === 0) {
      const aS = Math.hypot(sx, sz);
      const aD = cd * s * Math.hypot(px0, py0, pz0);
      const aPD = Math.hypot(ax, ay, az);
      A.push(`M1|${pre}|aS`, aS);
      A.push(`M1|${pre}|aD`, aD);
      A.push(`M1|${pre}|aPD`, aPD);
      A.push(`M1|${pre}|lam`, lam);
      A.push(`M1|${pre}|K`, (t.It * aPD) / (t.Ia * Math.max(1e-3, f.mag)));
      A.push(`M1|${pre}|aSoverPD`, aPD > 0 ? aS / aPD : NaN);
    }
    // M7：合成进动相位与实际倾斜方位之差（θ_v > 0.05 rad 时有定义）
    const tv = Math.acos(Math.max(-1, Math.min(1, f.up.y)));
    if (tv > 0.05) {
      const d = Math.abs(wrap(h.precession - Math.atan2(f.up.z, f.up.x)));
      A.inc(`M7|${t.key}|n`);
      if (d > Math.PI / 4) A.inc(`M7|${t.key}|gt45`);
      if (t.k % 2 === 0) A.push(`M7|${t.key}|dphi`, d);
    }
  },
};

/** 本步的接地类别（ContactService 已观测本步） */
function contactClass(cs: ContactService | null, side: string): number {
  if (!cs) return 3;
  const on = (part: string) => {
    const p = cs.colliderPair(`${side}:${part}`, 'arena:floor');
    return !!p && p.seenStep === cs.step && p.physicalContact;
  };
  if (on('shaft')) return 1;
  if (on('ratchet') || on('blade')) return 2;
  if (on('bit')) return 0;
  return 3;
}

/** 一步结束后：接地类别与按类别的掉速 / 账本分项（M6），B 段起止 */
function afterStepTrack(t: Track, cs: ContactService | null, cls: Uint8Array, i: number, thetaRel: number, thetaV: number) {
  const bey = t.bey;
  const c = contactClass(cs, t.side);
  if (i < cls.length) cls[i] = c;
  const spin = bey.spin;
  const dw = spin - t.prevSpin;
  t.prevSpin = spin;
  const led: Record<string, number> = {};
  for (const kk of LEDGER_KEYS) {
    led[kk] = bey.ledger[kk] - t.prevLedger[kk];
    t.prevLedger[kk] = bey.ledger[kk];
  }
  t.k++;
  if (!t.collect || !t.active || bey.bursted) {
    if (c !== 1 && t.bStart >= 0) t.bStart = -1;
    return;
  }
  const A = t.A;
  const nm = CLS[c];
  A.inc(`M6|${t.key}|cls|${nm}`);
  A.inc(`M6|${t.key}|cls|${nm}|dw`, -dw / DT);
  for (const kk of ['base', 'scrape', 'drive', 'contactLoss', 'contactGain'] as const) A.inc(`M6|${t.key}|cls|${nm}|${kk}`, led[kk] / DT);
  if (c === 1 && t.bStart < 0) {
    t.bStart = t.k;
    A.push(`M6|${t.key}|Bstart.thetaRel`, thetaRel);
    A.push(`M6|${t.key}|Bstart.thetaV`, thetaV);
  } else if (c !== 1 && t.bStart >= 0) {
    A.push(`M6|${t.key}|Blen`, (t.k - t.bStart) * DT);
    t.bStart = -1;
  }
}

function closeTrack(t: Track) {
  if (t.collect && t.bStart >= 0) {
    t.A.push(`M6|${t.key}|Blen`, (t.k - t.bStart) * DT);
    t.A.inc(`M6|${t.key}|BlenOpen`);
  }
  t.bStart = -1;
}

// ───────────────────────────── 终结过程与撞后恢复（未舍入，与 analyzeRound 同一定义） ─────────────────────────────

export interface FinishU {
  destab: boolean;
  /** 过程时长（s，未舍入） */
  D: number;
  censored: boolean;
  rho: number | null;
  loserEx: number;
  winnerEx: number;
  /** 失衡起始转速比例（无失衡过程时取发起时刻，与 analyzeRound 相同） */
  onset: number;
  loser: number;
  tStar: number;
  i0: number;
}

function excess(tr: Trace, k: number, base: number): Float32Array {
  const e = new Float32Array(tr.n);
  for (let i = 0; i < tr.n; i++) e[i] = tr.v(k, i, C.tiltN) - base;
  return e;
}

/** m4.metrics.ts finishProcess 的同一算法，不舍入（只取判定需要的字段） */
export function finishU(tr: Trace, fin: FinishInfo, ex: Float32Array[]): FinishU | null {
  if (fin.kind !== 'win' || fin.cause !== 'finish' || fin.loser === null || fin.winner === null) return null;
  const L = fin.loser;
  const W = fin.winner;
  const i0 = Math.min(tr.n - 1, Math.max(0, Math.round(fin.initiatedAt / DT)));
  const lo = Math.max(0, i0 - steps(8));
  const e = ex[L];
  const destab = e[i0] >= 0.25;
  let tStar = i0;
  if (destab) {
    let below = 0;
    tStar = lo;
    for (let i = i0; i >= lo; i--) {
      if (e[i] < 0.25) {
        below++;
        if (below > steps(0.2)) {
          tStar = i + below;
          break;
        }
      } else below = 0;
    }
  }
  let rho: number | null = null;
  if (destab && i0 - tStar >= 12) {
    const xs: number[] = [];
    for (let i = tStar; i <= i0; i++) xs.push(e[i]);
    const idx = xs.map((v, j) => [v, j] as const).sort((p, q2) => p[0] - q2[0]);
    const rk = new Array<number>(xs.length);
    idx.forEach(([, j], r) => (rk[j] = r));
    const n = xs.length;
    let s = 0;
    for (let j = 0; j < n; j++) s += (j - rk[j]) ** 2;
    rho = 1 - (6 * s) / (n * (n * n - 1));
  }
  const avg = (k: number, a: number, b: number) => {
    const xs: number[] = [];
    for (let i = Math.max(0, a); i <= Math.min(tr.n - 1, b); i++) xs.push(ex[k][i]);
    return mean(xs);
  };
  return {
    destab,
    D: destab ? (i0 - tStar) * DT : 0,
    censored: destab && tStar <= lo,
    rho,
    loserEx: avg(L, i0 - steps(0.5), i0),
    winnerEx: avg(W, i0 - steps(0.5), i0),
    onset: tr.v(L, tStar, C.ratio),
    loser: L,
    tStar,
    i0,
  };
}

export interface KnockU {
  k: number;
  ratio: number;
  peak: number;
  pre: number;
  recover: number;
  censored: boolean;
  ip: number;
}

/** analyzeRound 的撞后恢复同一算法，不舍入，并保留峰值所在步 ip */
function knocksU(tr: Trace, ex: Float32Array[], eps: { start: number; end: number }[]): KnockU[] {
  const out: KnockU[] = [];
  const n = tr.n;
  for (let j = 0; j < eps.length; j++) {
    const s0 = eps[j].start;
    if (s0 < steps(1)) continue;
    const next = j + 1 < eps.length ? eps[j + 1].start : n;
    for (let k = 0; k < tr.beys; k++) {
      const pre = mean(Array.from({ length: 12 }, (_, d) => ex[k][Math.max(0, s0 - 12 + d)]));
      let peak = -Infinity;
      let ip = s0;
      for (let i = s0; i < Math.min(n, s0 + steps(0.4)); i++)
        if (ex[k][i] > peak) {
          peak = ex[k][i];
          ip = i;
        }
      if (peak - pre < 0.1) continue;
      const lim = Math.min(n, ip + steps(1.5), next);
      let rec = -1;
      for (let i = ip; i < lim; i++)
        if (ex[k][i] <= pre + 0.03) {
          rec = i;
          break;
        }
      out.push({ k, ratio: tr.v(k, s0, C.ratio), peak, pre, recover: rec >= 0 ? (rec - ip) * DT : (lim - ip) * DT, censored: rec < 0, ip });
    }
  }
  return out;
}

// ───────────────────────────── 对战 ─────────────────────────────

/** 一个回合的场景行（§7.1）。所有比较 / 判定需要的量都在这里，数值不舍入 */
export interface RoundRow {
  t: 'R';
  set: SetName;
  arm: ArmName;
  /** 层（16 个有序对阵，matrixScenarios 顺序）与层内序号 */
  h: number;
  i: number;
  seed: number;
  p: string;
  r: string;
  pow: number;
  kind: string;
  finish: string | null;
  cause: string | null;
  /** 胜方 / 输方站位 0 = 玩家方、1 = 对手方 */
  win: number | null;
  lose: number | null;
  own: boolean;
  dur: number;
  bad: boolean;
  fp: (Omit<FinishU, 'tStar' | 'i0'> & { lk: string; bIn: boolean }) | null;
  frozen: number;
  /** 撞后恢复：[站位, 转速比例, 恢复时间, 未恢复(0/1), 峰值前后 0.4 s 内有 B 类(0/1), 峰值超出倾角, 撞前超出倾角] */
  kn: [number, number, number, number, number, number, number][];
  /** 前 1/3 回合（发射后 1 s 起）平均水平速度（回合 ≥ 15 s 才有） */
  sp1: [number, number] | null;
  /** 姿态正功 / 初始自转能量（两台） */
  wpd: [number, number];
  hash: number;
}

export interface ArmOutput {
  rows: RoundRow[];
  recs: RoundRec[];
  solo: SoloRow[];
  s3: S3Row[];
  agg: Agg;
  hashes: number[];
  checks: { finishMismatch: number; knockMismatch: number; probeMismatch: number };
  ms: { matrix: number; solo: number; s3: number };
}

function runMatrix(R: R, set: SetName, arm: ArmName, agg: Agg, collect: boolean, checks: ArmOutput['checks'], onRow: (row: RoundRow, rec: RoundRec) => void) {
  const { base, seeds } = SETS[set];
  const scs = matrixScenarios(base, seeds);
  scs.forEach((sc, idx) => {
    const h = Math.floor(idx / seeds);
    const i = idx % seeds;
    tracks.clear();
    let tr: Trace | null = null;
    let floor: RAPIER.Collider | null = null;
    let seen = 0;
    let frameImp = 0;
    let A: Track | null = null;
    let B: Track | null = null;
    const hs = new Hasher();
    let cls: Uint8Array[] = [];
    let stallN = 0;
    const stallCls = [0, 0, 0, 0];
    const matchup = sc.name.split('#')[0];
    runRound(
      R,
      sc,
      (ctx) => {
        if (!tr) {
          tr = new Trace(2, (sc.maxSeconds ?? 61) + 1);
          floor = findFloor(R, ctx.pw.world);
          cls = [new Uint8Array(tr.cap), new Uint8Array(tr.cap)];
        }
        const hit = ctx.b.impacts.length > seen;
        seen = ctx.b.impacts.length;
        const i0 = tr.n;
        tr.record(ctx.pw.world, [ctx.A, ctx.B], floor!, frameImp, hit);
        frameImp = 0;
        const cs = ctx.pw.contacts;
        for (const [t, k] of [
          [A!, 0],
          [B!, 1],
        ] as const) {
          afterStepTrack(t, cs, cls[k], i0, tr.v(k, i0, C.tiltN), tr.v(k, i0, C.tiltV));
          hs.bey(t.bey);
        }
        // 僵持（P2.3.1 定义：两台水平速度都 < 0.8、中心距 < 刀刃半径和 + 0.4、转速都 > 10）中的接地类别
        if (collect && A!.active && B!.active) {
          const pa = ctx.A.body.translation();
          const pb = ctx.B.body.translation();
          const va = ctx.A.body.linvel();
          const vb = ctx.B.body.linvel();
          const dd = Math.hypot(pa.x - pb.x, pa.z - pb.z);
          if (Math.hypot(va.x, va.z) < 0.8 && Math.hypot(vb.x, vb.z) < 0.8 && dd < ctx.A.spec.blade.radius + ctx.B.spec.blade.radius + 0.4 && ctx.A.spin > 10 && ctx.B.spin > 10) {
            stallN++;
            stallCls[cls[0][i0]]++;
            stallCls[cls[1][i0]]++;
          }
        }
        // 下一步的“发射过渡之后”标志（探针在下一步 preStep 中读取）
        A!.active = ctx.A.intent.state !== 'launch';
        B!.active = ctx.B.intent.state !== 'launch';
      },
      (ctx, rec) => {
        const o = ctx.b.judgeRound.outcome;
        const side = (s: string | null | undefined) => (s === 'player' ? 0 : s === 'rival' ? 1 : null);
        const fin: FinishInfo = { kind: o ? o.kind : 'none', finish: o?.finish ?? null, cause: o?.cause ?? null, winner: side(o?.winner), loser: side(o?.loser), initiatedAt: o?.initiatedAt ?? rec.dur };
        const t = tr!;
        const keys = [rec.p, rec.r];
        const m: RoundMetrics = analyzeRound(t, keys, fin);
        const free = freeMask(t);
        const ex = [0, 1].map((k) => excess(t, k, baseTilt(t, k, free)));
        const fu = finishU(t, fin, ex);
        // 与现有 analyzeRound（已舍入）一致性核对
        const fp = m.finishProc as Record<string, unknown> | null;
        if (!!fu !== !!fp || (fu && fp && (fu.destab !== fp.destabilized || r2(fu.D) !== fp.duration || r3(fu.onset) !== fp.loserRatioAtOnset || (fu.rho === null ? null : r3(fu.rho)) !== fp.rho || r3(fu.loserEx) !== fp.loserExcessEnd))) checks.finishMismatch++;
        // 接触段：用 analyzeRound 同一来源（episodes）重算撞后恢复
        const eps = epsOf(t);
        const kn = knocksU(t, ex, eps);
        if (kn.length !== m.knocks.length || kn.some((x, j) => r3(x.recover) !== m.knocks[j].recover || x.censored !== m.knocks[j].censored || r3(x.ratio) !== m.knocks[j].ratio)) checks.knockMismatch++;
        const nearB = (k: number, a: number, b: number) => {
          for (let q = Math.max(0, a); q <= Math.min(t.n - 1, b); q++) if (cls[k][q] === 1) return true;
          return false;
        };
        let sp1: [number, number] | null = null;
        if (t.n * DT >= 15) {
          const cut = Math.floor(t.n / 3);
          sp1 = [0, 1].map((k) => {
            let ss = 0;
            let c = 0;
            for (let q = steps(1); q < cut; q++) {
              ss += t.speed(k, q);
              c++;
            }
            return ss / Math.max(1, c);
          }) as [number, number];
        }
        for (const tk of [A!, B!]) {
          closeTrack(tk);
          checks.probeMismatch += tk.probeMismatch;
        }
        if (collect) {
          agg.inc(`M6|stall|${matchup}|steps`, stallN);
          CLS.forEach((nm, c) => agg.inc(`M6|stall|${matchup}|${nm}`, stallCls[c]));
          agg.push(`WPD|S1|${rec.p}`, A!.WpdPos / A!.E0);
          agg.push(`WPD|S1|${rec.r}`, B!.WpdPos / B!.E0);
        }
        const row: RoundRow = {
          t: 'R',
          set,
          arm,
          h,
          i,
          seed: sc.seed,
          p: rec.p,
          r: rec.r,
          pow: POW[i % 3],
          kind: rec.kind,
          finish: rec.finish,
          cause: rec.cause,
          win: fin.winner,
          lose: fin.loser,
          own: rec.own,
          dur: rec.dur,
          bad: rec.bad,
          fp: fu ? { destab: fu.destab, D: fu.D, censored: fu.censored, rho: fu.rho, loserEx: fu.loserEx, winnerEx: fu.winnerEx, onset: fu.onset, loser: fu.loser, lk: keys[fu.loser], bIn: nearB(fu.loser, fu.tStar, fu.i0) } : null,
          frozen: m.longestFrozen,
          kn: kn.map((x) => [x.k, x.ratio, x.recover, x.censored ? 1 : 0, nearB(x.k, x.ip - steps(0.4), x.ip + steps(0.4)) ? 1 : 0, x.peak, x.pre]),
          sp1,
          wpd: [A!.WpdPos / A!.E0, B!.WpdPos / B!.E0],
          hash: hs.h,
        };
        onRow(row, rec);
      },
      (ctx) => {
        A = new Track(sc.name.split('-')[0], 'player', ctx.A, agg, collect);
        B = new Track(sc.name.split('-')[1].split('#')[0], 'rival', ctx.B, agg, collect);
        tracks.set(ctx.A, A);
        tracks.set(ctx.B, B);
        const after = ctx.pw.afterStep;
        ctx.pw.afterStep = (dt) => {
          after?.(dt);
          frameImp += ctx.pw.contacts?.bodyPair('player', 'rival')?.normalImpulse ?? 0;
        };
      },
    );
  });
}

// ───────────────────────────── 单台 S2 ─────────────────────────────

export interface SoloRow {
  t: 'S2';
  set: SetName;
  arm: ArmName;
  name: string;
  power: number;
  seed: number;
  end: string;
  endAt: number;
  /** 终结时刻的转速（倾倒时的转速，M5） */
  endSpin: number;
  destabDuration: number | null;
  destabOnsetRatio: number | null;
  wpd: number;
  hash: number;
}

function runSolo(R: R, set: SetName, arm: ArmName, agg: Agg, collect: boolean, checks: ArmOutput['checks']): SoloRow[] {
  const names: string[] = [];
  for (const sg of SIGNATURE_LIST) for (let i = 0; i < POW.length * 2; i++) names.push(sg.key);
  for (const bit of Object.keys(BITS)) for (let i = 0; i < 3; i++) names.push(`衡+${bit}`);
  let idx = 0;
  const solo = soloSuite(R, {
    instrument: (pw: PhysicsWorld, bey: BeyPhysics) => {
      tracks.clear();
      const cs = pw.contacts;
      cs?.setSubjects(() => [{ owner: 'player', colliders: bey.colliders, parts: BEY_COLLIDER_PARTS }]);
      bey.contactOwner = 'player';
      const nm = names[idx++] ?? '?';
      const t = new Track(nm, 'player', bey, agg, collect && SIGNATURE_LIST.some((s) => s.key === nm));
      tracks.set(bey, t);
      const hs = new Hasher();
      const spins: number[] = [];
      const cls = new Uint8Array(Math.ceil(151 / DT) + 4);
      let k = 0;
      const prev = pw.afterStep;
      pw.afterStep = (dt) => {
        prev?.(dt);
        const up = bey.up();
        afterStepTrack(t, cs, cls, k, NaN, Math.acos(Math.max(-1, Math.min(1, up.y))));
        hs.bey(bey);
        spins.push(bey.spin);
        k++;
        t.active = k * DT >= 1;
      };
      return () => {
        closeTrack(t);
        checks.probeMismatch += t.probeMismatch;
        return { key: t.key, hash: hs.h, spins, wpd: t.WpdPos / t.E0 };
      };
    },
  });
  return solo.recs.map((sr) => {
    const x = sr.instr as { key: string; hash: number; spins: number[]; wpd: number };
    if (x.key !== sr.name) throw new Error(`单台顺序不一致：${x.key} ≠ ${sr.name}`);
    const i0 = Math.max(0, Math.min(x.spins.length - 1, Math.round(sr.endAt / DT) - 1));
    if (collect && SIGNATURE_LIST.some((s) => s.key === sr.name)) agg.push(`WPD|S2|${sr.name}`, x.wpd);
    return { t: 'S2', set, arm, name: sr.name, power: sr.power, seed: sr.seed, end: sr.end, endAt: sr.endAt, endSpin: x.spins[i0], destabDuration: sr.destabDuration, destabOnsetRatio: sr.destabOnsetRatio, wpd: x.wpd, hash: x.hash };
  });
}

// ───────────────────────────── 撞后恢复探针 S3 ─────────────────────────────

export interface S3Row {
  t: 'S3';
  set: SetName;
  arm: ArmName;
  key: string;
  si: number;
  ri: number;
  k: number;
  seed: number;
  ratio: number;
  dp: number;
  /** 发射后转速比例第一次降到目标时施加；没到目标就结束 → reached = false */
  reached: boolean;
  spinAt: number | null;
  pre: number | null;
  peak: number | null;
  recover: number | null;
  censored: boolean | null;
  fell: boolean | null;
  /** 扰动后 3 s 内 B 类（轴杆参与接地）步的占比 */
  bShare: number | null;
  hash: number;
}

/**
 * 单台 S3：与 soloRun 相同的建场与发射（力度 0.8）；转速比例第一次 ≤ 目标时，在两步之间把刚体角速度加上 Δp·n̂，
 * n̂ = 归一化(û × d̂)，d̂ = 水平方向 (cos ψ, 0, sin ψ)，ψ = 当前倾斜方位 + k·120°（让转轴朝 d̂ 倾倒；只改横向角速度，不改自转）。
 * 峰值 = 扰动后 0.5 s 内的最大 θ_v；恢复 = 峰值之后第一次 θ_v ≤ 扰动前 0.1 s 平均 + 0.03；3 s 截尾；倒下 = 3 s 内出现终结条件。
 */
export function runS3(R: R, set: SetName, arm: ArmName, si: number, ri: number, k: number, dp: number): S3Row {
  const sg = SIGNATURE_LIST[si];
  const seed = 95000 + 100 * si + 10 * ri + k;
  const target = S3_RATIOS[ri];
  const rnd0 = Math.random;
  Math.random = seeded(seed);
  try {
    const pw = new PhysicsWorld(R, { observeContacts: true });
    createArenaPhysics(pw);
    const spec = assembleBey(sg.loadout);
    const rnd = seeded(seed * 7 + 13);
    const params = computeLaunch(spec, 'player', { power: S3_POWER, aim: (rnd() - 0.5) * 0.8, tilt: 0 });
    const bey = new BeyPhysics(pw, spec, { ...params, seed });
    pw.beforeStep = (dt) => bey.preStep(dt);
    const cs = pw.contacts;
    cs?.setSubjects(() => [{ owner: 'player', colliders: bey.colliders, parts: BEY_COLLIDER_PARTS }]);
    bey.contactOwner = 'player';
    const hs = new Hasher();
    const tv: number[] = [];
    const bcls: number[] = [];
    let applied = -1;
    let spinAt: number | null = null;
    let fell = false;
    let ended = false;
    const max = steps(150);
    for (let s = 0; s < max; s++) {
      pw.step();
      hs.bey(bey);
      const up = bey.up();
      tv.push(Math.acos(Math.max(-1, Math.min(1, up.y))));
      bcls.push(contactClass(cs, 'player'));
      const p = bey.body.translation();
      const r = Math.hypot(p.x, p.z);
      const isOut = r > ARENA.radius + FINISH_TUNING.outMargin || p.y < TABLE_Y + 0.5;
      const toppled = bey.tilt > FINISH_TUNING.toppleTilt && bey.spin < FINISH_TUNING.toppleSpin;
      const stopped = bey.spin < FINISH_TUNING.stopSpin;
      if (isOut || toppled || stopped) {
        if (applied < 0) {
          ended = true;
          break;
        }
        fell = true;
      }
      if (applied < 0 && s * DT >= 1 && bey.spinRatio <= target) {
        applied = s;
        spinAt = bey.spin;
        const az = Math.atan2(up.z, up.x) + (k * 2 * Math.PI) / 3;
        const dx = Math.cos(az);
        const dz = Math.sin(az);
        // n̂ = û × d̂
        let nx = up.y * dz - up.z * 0;
        let ny = up.z * dx - up.x * dz;
        let nz = up.x * 0 - up.y * dx;
        const l = Math.hypot(nx, ny, nz) || 1;
        nx /= l;
        ny /= l;
        nz /= l;
        const w = bey.body.angvel();
        bey.body.setAngvel({ x: w.x + dp * nx, y: w.y + dp * ny, z: w.z + dp * nz }, true);
      }
      if (applied >= 0 && s >= applied + steps(3)) break;
    }
    pw.dispose();
    const base = { t: 'S3' as const, set, arm, key: sg.key, si, ri, k, seed, ratio: target, dp, hash: hs.h };
    if (applied < 0 || ended) return { ...base, reached: false, spinAt: null, pre: null, peak: null, recover: null, censored: null, fell: null, bShare: null };
    const pre = mean(tv.slice(Math.max(0, applied - 11), applied + 1));
    let peak = -Infinity;
    let ip = applied + 1;
    for (let q = applied + 1; q <= Math.min(tv.length - 1, applied + steps(0.5)); q++)
      if (tv[q] > peak) {
        peak = tv[q];
        ip = q;
      }
    let rec = -1;
    const lim = Math.min(tv.length, applied + steps(3) + 1);
    for (let q = ip; q < lim; q++)
      if (tv[q] <= pre + 0.03) {
        rec = q;
        break;
      }
    const win = bcls.slice(applied + 1, lim);
    return { ...base, reached: true, spinAt, pre, peak, recover: rec >= 0 ? (rec - ip) * DT : (lim - 1 - ip) * DT, censored: rec < 0, fell, bShare: win.length ? win.filter((c) => c === 1).length / win.length : 0 };
  } finally {
    Math.random = rnd0;
  }
}

export function runS3Suite(R: R, set: SetName, arm: ArmName, dp: number): S3Row[] {
  const rows: S3Row[] = [];
  for (let si = 0; si < SIGNATURE_LIST.length; si++) for (let ri = 0; ri < S3_RATIOS.length; ri++) for (let k = 0; k < 3; k++) rows.push(runS3(R, set, arm, si, ri, k, dp));
  return rows;
}

// ───────────────────────────── 一个臂的完整运行 ─────────────────────────────

export function runArm(R: R, set: SetName, arm: ArmName, dp: number, collect: boolean, onRow?: (row: RoundRow) => void): ArmOutput {
  const agg = new Agg();
  const checks = { finishMismatch: 0, knockMismatch: 0, probeMismatch: 0 };
  const rows: RoundRow[] = [];
  const recs: RoundRec[] = [];
  const ms = { matrix: 0, solo: 0, s3: 0 };
  let solo: SoloRow[] = [];
  let s3: S3Row[] = [];
  withArm(arm, () => {
    EXECUTOR_PROBE.on = PROBE;
    try {
      let t0 = Date.now();
      runMatrix(R, set, arm, agg, collect, checks, (row, rec) => {
        rows.push(row);
        recs.push(rec);
        onRow?.(row);
      });
      ms.matrix = Date.now() - t0;
      t0 = Date.now();
      solo = runSolo(R, set, arm, agg, collect, checks);
      ms.solo = Date.now() - t0;
      t0 = Date.now();
      tracks.clear();
      s3 = runS3Suite(R, set, arm, dp);
      ms.s3 = Date.now() - t0;
    } finally {
      EXECUTOR_PROBE.on = null;
      tracks.clear();
    }
  });
  const hashes = [...rows.map((r) => r.hash), ...solo.map((r) => r.hash), ...s3.map((r) => r.hash)];
  return { rows, recs, solo, s3, agg, hashes, checks, ms };
}

/** 汇总：分布量的分位数、计数 */
export function aggReport(agg: Agg) {
  const dists: Record<string, unknown> = {};
  for (const [k, a] of Object.entries(agg.d).sort()) dists[k] = quant(a);
  return { counts: Object.fromEntries(Object.entries(agg.c).sort()), dists };
}

export { summarize };

/** 输出：同时写入 test-results/<file> 与日志（行首 tag） */
export function emit(file: string, tag: string, v: unknown) {
  const line = JSON.stringify(v);
  console.log(`${tag} ${line}`);
  mkdirSync('test-results', { recursive: true });
  appendFileSync(`test-results/${file}`, `${line}\n`);
}
