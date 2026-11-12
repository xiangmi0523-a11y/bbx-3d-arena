/// <reference types="node" />
/**
 * M4 测量口径（docs/engineering/m4-experiment-plan.md §2 预注册；M4-A 起所有 M4 实验共用，改口径必须先改计划文档再改这里）。
 *
 * 逐步记录一台或两台陀螺的运动、姿态、接触与触地，回合结束后计算指标。只读物理：只调用 Rapier 的查询接口
 * （translation / rotation / linvel / angvel / contactPair），不写任何状态；M4-A 用 M5b base 臂的终结计数核对“记录不改变结果”。
 * 这里产生的全部是【模拟实测】；录像提取见 m4-reference-battles.md，理论推算在 m4a-baseline.diag.ts 的 THEORY 部分。
 *
 * 角度口径：tiltV = 转轴与竖直方向的夹角；tiltN = 转轴与所在位置地面法线的夹角（碗面有坡度，触地看的是相对地面的倾角）。
 * “基准倾角” = 本台转速比例 > 0.6 的自由运动段 tiltN 的中位数；“超出倾角” excess = tiltN − 基准倾角。
 * 自由运动 = 不在接触中、距上次接触 ≥ 0.3 s、发射后 ≥ 1 s。
 */
import type RAPIER from '@dimforge/rapier3d-compat';
import { ARENA, floorNormal } from '../../src/game/arena/arenaSpec';
import { BURST_TUNING, EpisodeTracker } from '../../src/game/battle/burst';
import type { BeyPhysics } from '../../src/game/beys/BeyPhysics';
import { PHYSICS_DT } from '../../src/game/physics/PhysicsWorld';

export const STATE_NAMES = ['launch', 'roam', 'orbit', 'cut', 'contact', 'disengage', 'guard', 'evade', 'breakout'] as const;
const STATE_INDEX = new Map<string, number>(STATE_NAMES.map((s, i) => [s, i]));

/** 每台每步记录的字段 */
export const C = { spin: 0, ratio: 1, x: 2, z: 3, y: 4, vx: 5, vz: 6, tiltV: 7, tiltN: 8, az: 9, wPerp: 10, flags: 11, state: 12 } as const;
const NC = 13;
export const FL = { contact: 1, floor: 2, dash: 4, breakout: 8, knocked: 16, hit: 32 } as const;

const DT = PHYSICS_DT;
export const steps = (sec: number) => Math.round(sec / DT);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
export function median(a: number[]): number {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
export function q(a: number[], p: number): number {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1) + 0.5)))];
}
export const r3 = (v: number) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : v);
export const r2 = (v: number) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : v);

/** contactPair 回调里用到的流形接口（Rapier TempContactManifold 的子集） */
interface Manifold {
  numSolverContacts(): number;
  solverContactDist(i: number): number;
  numContacts(): number;
  contactImpulse(i: number): number;
}

/** 触地：Bit 接地球以外的碰撞体（轴杆 / Ratchet / Blade）与场地地面有求解器接触（距离 ≤ 1 mm）或接触冲量 */
export function floorTouch(world: RAPIER.World, b: BeyPhysics, floor: RAPIER.Collider): boolean {
  let hit = false;
  for (let i = 1; i < b.colliders.length && !hit; i++) {
    world.contactPair(b.colliders[i], floor, (m: Manifold) => {
      for (let k = 0, n = m.numSolverContacts(); k < n; k++) if (m.solverContactDist(k) <= 0.001) hit = true;
      for (let k = 0, n = m.numContacts(); k < n; k++) if (m.contactImpulse(k) > 0) hit = true;
    });
  }
  return hit;
}

/** 找到场地地面（三角网格）碰撞体 */
export function findFloor(R: typeof RAPIER, world: RAPIER.World): RAPIER.Collider {
  let floor: RAPIER.Collider | null = null;
  world.colliders.forEach((c: RAPIER.Collider) => {
    if (!floor && c.shapeType() === R.ShapeType.TriMesh) floor = c;
  });
  if (!floor) throw new Error('没有找到场地地面碰撞体');
  return floor;
}

export class Trace {
  readonly beys: number;
  readonly cap: number;
  n = 0;
  readonly d: Float32Array[];
  /** 两台之间本步的身体级法向冲量（ContactService）；单台记录为 0 */
  readonly imp: Float32Array;
  constructor(beys: number, maxSeconds: number) {
    this.beys = beys;
    this.cap = Math.ceil(maxSeconds / DT) + 4;
    this.d = Array.from({ length: beys }, () => new Float32Array(this.cap * NC));
    this.imp = new Float32Array(this.cap);
  }
  v(k: number, i: number, c: number): number {
    return this.d[k][i * NC + c];
  }
  has(k: number, i: number, f: number): boolean {
    return ((this.d[k][i * NC + C.flags] | 0) & f) !== 0;
  }
  speed(k: number, i: number): number {
    return Math.hypot(this.v(k, i, C.vx), this.v(k, i, C.vz));
  }
  radius(k: number, i: number): number {
    return Math.hypot(this.v(k, i, C.x), this.v(k, i, C.z));
  }
  /** 第 i 步结束时的回合时间（秒） */
  time(i: number): number {
    return (i + 1) * DT;
  }
  record(world: RAPIER.World, list: BeyPhysics[], floor: RAPIER.Collider, impulse: number, hit: boolean): void {
    if (this.n >= this.cap) return;
    const i = this.n++;
    this.imp[i] = impulse;
    for (let k = 0; k < list.length; k++) {
      const b = list[k];
      const o = i * NC;
      const a = this.d[k];
      const p = b.body.translation();
      const v = b.body.linvel();
      const w = b.body.angvel();
      const u = b.up();
      const r = Math.hypot(p.x, p.z);
      const n = r <= ARENA.radius ? floorNormal(p.x, p.z) : [0, 1, 0];
      const dot = Math.max(-1, Math.min(1, u.x * n[0] + u.y * n[1] + u.z * n[2]));
      const ws = w.x * u.x + w.y * u.y + w.z * u.z;
      a[o + C.spin] = b.spin;
      a[o + C.ratio] = b.spinRatio;
      a[o + C.x] = p.x;
      a[o + C.z] = p.z;
      a[o + C.y] = p.y;
      a[o + C.vx] = v.x;
      a[o + C.vz] = v.z;
      a[o + C.tiltV] = Math.acos(Math.max(-1, Math.min(1, u.y)));
      a[o + C.tiltN] = Math.acos(dot);
      a[o + C.az] = Math.atan2(u.z, u.x);
      a[o + C.wPerp] = Math.hypot(w.x - u.x * ws, w.y - u.y * ws, w.z - u.z * ws);
      let f = 0;
      if (impulse > 0) f |= FL.contact;
      if (floorTouch(world, b, floor)) f |= FL.floor;
      if (b.dashing) f |= FL.dash;
      if (b.breakout > 0) f |= FL.breakout;
      if (b.knocked) f |= FL.knocked;
      if (hit) f |= FL.hit;
      a[o + C.flags] = f;
      a[o + C.state] = STATE_INDEX.get(b.intentState) ?? -1;
    }
  }
}

// ───────────────────────────── 派生序列 ─────────────────────────────

/** 自由运动掩码：不在接触中、距上次接触 ≥ 0.3 s、发射后 ≥ 1 s */
export function freeMask(tr: Trace): Uint8Array {
  const m = new Uint8Array(tr.n);
  let last = -1e9;
  for (let i = 0; i < tr.n; i++) {
    if (tr.imp[i] > 0) last = i;
    m[i] = i - last >= steps(0.3) && i >= steps(1) ? 1 : 0;
  }
  return m;
}

/** 基准倾角：转速比例 > 0.6 的自由运动段 tiltN 中位数（样本 < 60 步时退回前 1/3 回合的自由运动段） */
export function baseTilt(tr: Trace, k: number, free: Uint8Array): number {
  const a: number[] = [];
  for (let i = 0; i < tr.n; i++) if (free[i] && tr.v(k, i, C.ratio) > 0.6) a.push(tr.v(k, i, C.tiltN));
  if (a.length >= 60) return median(a);
  const b: number[] = [];
  for (let i = 0; i < Math.floor(tr.n / 3); i++) if (free[i]) b.push(tr.v(k, i, C.tiltN));
  return b.length ? median(b) : 0;
}

/** 摇摆幅度：tiltN 与其 ±0.25 s 滑动平均之差的绝对值 */
export function wobbleSeries(tr: Trace, k: number): Float32Array {
  const n = tr.n;
  const out = new Float32Array(n);
  const h = steps(0.25);
  const cs = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + tr.v(k, i, C.tiltN);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - h);
    const b = Math.min(n, i + h + 1);
    out[i] = Math.abs(tr.v(k, i, C.tiltN) - (cs[b] - cs[a]) / (b - a));
  }
  return out;
}

/** 进动角速度：转轴方位角的变化率（rad/s，只在相邻两步 tiltV 都 > 0.03 时有定义，否则 NaN） */
export function precessionAt(tr: Trace, k: number, i: number): number {
  if (i < 1 || tr.v(k, i, C.tiltV) <= 0.03 || tr.v(k, i - 1, C.tiltV) <= 0.03) return NaN;
  return Math.abs(wrap(tr.v(k, i, C.az) - tr.v(k, i - 1, C.az))) / DT;
}

// ───────────────────────────── 按转速比例分档的曲线 ─────────────────────────────

const NB = 10;
export interface CurveAcc {
  n: number[];
  speed: number[];
  r: number[];
  tiltN: number[];
  wobble: number[];
  wPerp: number[];
  prec: number[];
  nPrec: number[];
  floor: number[];
}
export const newCurve = (): CurveAcc => ({ n: Array(NB).fill(0), speed: Array(NB).fill(0), r: Array(NB).fill(0), tiltN: Array(NB).fill(0), wobble: Array(NB).fill(0), wPerp: Array(NB).fill(0), prec: Array(NB).fill(0), nPrec: Array(NB).fill(0), floor: Array(NB).fill(0) });

/** 自由运动段按转速比例（0.1 一档）累计：平移速度、半径、tiltN、摇摆、横向角速度、进动、触地占比 */
export function addCurves(tr: Trace, k: number, acc: CurveAcc, free: Uint8Array): void {
  const wob = wobbleSeries(tr, k);
  for (let i = 0; i < tr.n; i++) {
    if (!free[i]) continue;
    const b = Math.min(NB - 1, Math.max(0, Math.floor(tr.v(k, i, C.ratio) * NB)));
    acc.n[b]++;
    acc.speed[b] += tr.speed(k, i);
    acc.r[b] += tr.radius(k, i);
    acc.tiltN[b] += tr.v(k, i, C.tiltN);
    acc.wobble[b] += wob[i];
    acc.wPerp[b] += tr.v(k, i, C.wPerp);
    if (tr.has(k, i, FL.floor)) acc.floor[b]++;
    const p = precessionAt(tr, k, i);
    if (Number.isFinite(p)) {
      acc.prec[b] += p;
      acc.nPrec[b]++;
    }
  }
}

export function curveReport(acc: CurveAcc) {
  const rows: Record<string, number | string | null>[] = [];
  for (let b = NB - 1; b >= 0; b--) {
    const n = acc.n[b];
    if (!n) continue;
    rows.push({
      ratio: `${(b / NB).toFixed(1)}–${((b + 1) / NB).toFixed(1)}`,
      seconds: r2(n * DT),
      speed: r3(acc.speed[b] / n),
      r: r3(acc.r[b] / n),
      tiltN: r3(acc.tiltN[b] / n),
      wobble: r3(acc.wobble[b] / n),
      wPerp: r3(acc.wPerp[b] / n),
      precession: acc.nPrec[b] ? r3(acc.prec[b] / acc.nPrec[b]) : null,
      floorShare: r3(acc.floor[b] / n),
    });
  }
  return rows;
}

/** 曲线形状：转速比例 0.3–1.0 区间各档平均速度相对 0.9–1.0 档的最大降幅、0.3 以下的平均速度 / 0.9–1.0 档（E2 口径） */
export function curveShape(acc: CurveAcc) {
  const sp = (b: number) => (acc.n[b] ? acc.speed[b] / acc.n[b] : NaN);
  const top = Number.isFinite(sp(9)) ? sp(9) : sp(8);
  let maxDrop = 0;
  for (let b = 3; b <= 9; b++) if (Number.isFinite(sp(b))) maxDrop = Math.max(maxDrop, 1 - sp(b) / top);
  let lowN = 0;
  let lowS = 0;
  for (let b = 0; b < 3; b++) {
    lowN += acc.n[b];
    lowS += acc.speed[b];
  }
  return { speedTop: r3(top), maxDropAbove03: r3(maxDrop), lowOverTop: lowN ? r3(lowS / lowN / top) : null, speedAt05: r3(sp(5)), speedAt02: r3(sp(2)) };
}

// ───────────────────────────── 接触 ─────────────────────────────

export interface Episode {
  start: number;
  end: number;
  peak: number;
}

/** 接触段：与爆裂同一定义（法向冲量 > 0，间隔 ≤ holdTime 合并） */
export function episodes(tr: Trace): Episode[] {
  const ep = new EpisodeTracker(DT, BURST_TUNING.holdTime);
  const out: Episode[] = [];
  for (let i = 0; i < tr.n; i++) {
    const closed = ep.step(i, tr.imp[i]);
    if (closed) out.push({ start: closed.startStep, end: closed.lastStep, peak: closed.peakImpulse });
  }
  const f = ep.flush();
  if (f) out.push({ start: f.startStep, end: f.lastStep, peak: f.peakImpulse });
  return out;
}

/** 掩码上的连续段（间隔 ≤ gap 步合并） */
function runs(mask: (i: number) => boolean, n: number, gap: number): [number, number][] {
  const out: [number, number][] = [];
  let s = -1;
  let last = -1e9;
  for (let i = 0; i < n; i++) {
    if (!mask(i)) continue;
    if (s >= 0 && i - last <= gap + 1) last = i;
    else {
      if (s >= 0) out.push([s, last]);
      s = i;
      last = i;
    }
  }
  if (s >= 0) out.push([s, last]);
  return out;
}

// ───────────────────────────── 单回合指标 ─────────────────────────────

export interface FinishInfo {
  kind: 'win' | 'draw' | 'none';
  finish: string | null;
  cause: string | null;
  winner: number | null;
  loser: number | null;
  /** 决定胜负的终结发起时刻（秒） */
  initiatedAt: number;
}

export interface KnockEvent {
  key: string;
  ratio: number;
  /** 撞击前 0.1 s 的超出倾角、撞后 0.4 s 内的峰值（rad） */
  pre: number;
  peak: number;
  /** 从峰值回到 pre + 0.03 的时间（秒）；censored = 下一次接触 / 1.5 s / 回合结束前没恢复 */
  recover: number;
  censored: boolean;
  rehit: boolean;
}

export interface RoundMetrics {
  dur: number;
  keys: string[];
  /** 三等分时段（回合 ≥ 15 s 才有）：每台平均速度 / 半径，接触段数每秒 */
  thirds: { speed: number[][]; r: number[][]; contactRate: number[] } | null;
  /** 最后 10 s 与中段的接触频率（回合 ≥ 20 s 才有） */
  last10Rate: number | null;
  midRate: number | null;
  contacts: number;
  /** 最长连续接触（间隔 ≤ 0.1 s 合并）及其间两台连线方位的转动角速度（rad/s） */
  longestContact: number;
  longestContactBearingRate: number;
  /** 最长“贴住不动”：接触（间隔 ≤ 0.2 s 合并）且两台水平速度都 < 0.5 */
  longestFrozen: number;
  /** 连击：接触段之间间隔 ≤ 1.5 s 的链；≥ 3 段的链数、链中段数占比 */
  chains3: number;
  chainedShare: number;
  /** 每台：基准倾角、触地次数 / 时长、各意图状态时间占比、冲刺时间 */
  perBey: { key: string; baseTilt: number; floorEvents: number; floorSec: number; states: Record<string, number>; dashSec: number; breakoutSec: number }[];
  finishProc: Record<string, unknown> | null;
  knocks: KnockEvent[];
  /** 利用失衡：一台超出倾角越过 0.25（且之前 ≥ 1 s 低于）后 1.5 s 内是否开始一次接触 */
  followUps: { n: number; hit: number };
  /** 外圈切入：接触段开始前 0.05 s，接近更快的一方（进攻方）半径 − 另一方半径 */
  approachDr: number[];
  /** 逼墙：接触段开始时被撞方（接近更慢的一方）半径 < 4.4，0.6 s 内到达 ≥ 4.4 */
  wallPush: { n: number; hit: number };
}

/** 一台的基准倾角与超出倾角序列 */
function excessSeries(tr: Trace, k: number, base: number): Float32Array {
  const e = new Float32Array(tr.n);
  for (let i = 0; i < tr.n; i++) e[i] = tr.v(k, i, C.tiltN) - base;
  return e;
}

/**
 * 终结过程（只对“终结”判定的回合；超时 / 平局为 null）：
 *  - 失衡开始 t*：从发起时刻往回找，输方超出倾角 ≥ 0.25 rad 的连续段（允许 < 0.2 s 的回落）的起点；发起时刻本身 < 0.25 → 无失衡过程；
 *  - 过程时长 = 发起 − t*（窗口 8 s，超过记 ≥ 8 censored）；倾角上升 = 过程内 Spearman ρ（时间 vs 超出倾角）；
 *  - 赢方 / 输方发起前 0.5 s 的平均超出倾角；输方过程内平均速度 / 过程前 3 s 平均速度；
 *  - 输方最后 3 s 是否触地、首次触地距发起的秒数；最后一次接触距发起的秒数、该接触时输方的超出倾角；
 *  - 输方转速比例越过 0.5 / 0.3 到发起的秒数。
 */
function finishProcess(tr: Trace, fin: FinishInfo, ex: Float32Array[], eps: Episode[]) {
  if (fin.kind !== 'win' || fin.cause !== 'finish' || fin.loser === null || fin.winner === null) return null;
  const L = fin.loser;
  const W = fin.winner;
  const i0 = Math.min(tr.n - 1, Math.max(0, Math.round(fin.initiatedAt / DT)));
  const win = steps(8);
  const lo = Math.max(0, i0 - win);
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
  const D = destab ? (i0 - tStar) * DT : 0;
  const censored = destab && tStar <= lo;
  // Spearman ρ（时间 vs 超出倾角）
  let rho: number | null = null;
  if (destab && i0 - tStar >= 12) {
    const xs: number[] = [];
    for (let i = tStar; i <= i0; i++) xs.push(e[i]);
    const rank = (a: number[]) => {
      const idx = a.map((v, j) => [v, j] as const).sort((p, q2) => p[0] - q2[0]);
      const rk = new Array(a.length);
      idx.forEach(([, j], r) => (rk[j] = r));
      return rk as number[];
    };
    const ry = rank(xs);
    const n = xs.length;
    let s = 0;
    for (let j = 0; j < n; j++) s += (j - ry[j]) ** 2;
    rho = 1 - (6 * s) / (n * (n * n - 1));
  }
  const avg = (k: number, a: number, b: number, f: (k: number, i: number) => number) => {
    const xs: number[] = [];
    for (let i = Math.max(0, a); i <= Math.min(tr.n - 1, b); i++) xs.push(f(k, i));
    return mean(xs);
  };
  const exAt = (k: number) => (_k: number, i: number) => ex[k][i];
  const sp = (k: number, i: number) => tr.speed(k, i);
  let firstFloor: number | null = null;
  for (let i = Math.max(0, i0 - steps(3)); i <= i0; i++)
    if (tr.has(L, i, FL.floor)) {
      firstFloor = (i0 - i) * DT;
      break;
    }
  let lastEp: Episode | null = null;
  for (const ep of eps) if (ep.start <= i0) lastEp = ep;
  const cross = (thr: number) => {
    for (let i = 0; i <= i0; i++) if (tr.v(L, i, C.ratio) < thr) return r2((i0 - i) * DT);
    return null;
  };
  return {
    loserKey: '',
    finish: fin.finish,
    destabilized: destab,
    duration: r2(D),
    censored,
    rho: rho === null ? null : r3(rho),
    loserExcessEnd: r3(avg(L, i0 - steps(0.5), i0, exAt(L))),
    winnerExcessEnd: r3(avg(W, i0 - steps(0.5), i0, exAt(W))),
    loserRatioAtOnset: r3(tr.v(L, tStar, C.ratio)),
    loserRatioEnd: r3(tr.v(L, i0, C.ratio)),
    speedDuringOverBefore: destab && i0 - tStar >= 12 ? r3(avg(L, tStar, i0, sp) / Math.max(1e-3, avg(L, tStar - steps(3), tStar - 1, sp))) : null,
    floorInLast3s: firstFloor !== null,
    firstFloorBeforeEnd: firstFloor === null ? null : r2(firstFloor),
    lastContactBeforeEnd: lastEp ? r2((i0 - lastEp.end) * DT) : null,
    loserExcessAtLastContact: lastEp ? r3(ex[L][lastEp.start]) : null,
    sinceRatio05: cross(0.5),
    sinceRatio03: cross(0.3),
  };
}

export function analyzeRound(tr: Trace, keys: string[], fin: FinishInfo): RoundMetrics {
  const n = tr.n;
  const dur = n * DT;
  const free = freeMask(tr);
  const nb = tr.beys;
  const bases = Array.from({ length: nb }, (_, k) => baseTilt(tr, k, free));
  const ex = bases.map((b, k) => excessSeries(tr, k, b));
  const eps = nb === 2 ? episodes(tr) : [];
  const rate = (a: number, b: number) => eps.filter((e) => e.start >= a && e.start < b).length / Math.max(DT, (b - a) * DT);
  let thirds: RoundMetrics['thirds'] = null;
  if (dur >= 15) {
    const cut = [0, Math.floor(n / 3), Math.floor((2 * n) / 3), n];
    const speed: number[][] = [];
    const rr: number[][] = [];
    for (let k = 0; k < nb; k++) {
      const s: number[] = [];
      const r: number[] = [];
      for (let t = 0; t < 3; t++) {
        let ss = 0;
        let rs = 0;
        let c = 0;
        for (let i = Math.max(cut[t], steps(1)); i < cut[t + 1]; i++) {
          ss += tr.speed(k, i);
          rs += tr.radius(k, i);
          c++;
        }
        s.push(r3(ss / Math.max(1, c)));
        r.push(r3(rs / Math.max(1, c)));
      }
      speed.push(s);
      rr.push(r);
    }
    thirds = { speed, r: rr, contactRate: nb === 2 ? [0, 1, 2].map((t) => r3(rate(cut[t], cut[t + 1]))) : [] };
  }
  const last10Rate = nb === 2 && dur >= 20 ? r3(rate(n - steps(10), n)) : null;
  const midRate = nb === 2 && dur >= 20 ? r3(rate(Math.floor(n / 3), Math.floor((2 * n) / 3))) : null;

  // 最长连续接触与连线方位转动；最长“贴住不动”
  let longestContact = 0;
  let bearingRate = 0;
  let longestFrozen = 0;
  if (nb === 2) {
    for (const [a, b] of runs((i) => tr.imp[i] > 0, n, steps(0.1))) {
      const len = (b - a + 1) * DT;
      if (len > longestContact) {
        longestContact = len;
        let tot = 0;
        let prev = Math.atan2(tr.v(1, a, C.z) - tr.v(0, a, C.z), tr.v(1, a, C.x) - tr.v(0, a, C.x));
        for (let i = a + 1; i <= b; i++) {
          const cur = Math.atan2(tr.v(1, i, C.z) - tr.v(0, i, C.z), tr.v(1, i, C.x) - tr.v(0, i, C.x));
          tot += Math.abs(wrap(cur - prev));
          prev = cur;
        }
        bearingRate = len > 0 ? tot / len : 0;
      }
    }
    for (const [a, b] of runs((i) => tr.imp[i] > 0 && tr.speed(0, i) < 0.5 && tr.speed(1, i) < 0.5, n, steps(0.2))) longestFrozen = Math.max(longestFrozen, (b - a + 1) * DT);
  }
  // 连击链
  let chains3 = 0;
  let chained = 0;
  if (eps.length) {
    let len = 1;
    const close = () => {
      if (len >= 3) chains3++;
      if (len >= 2) chained += len;
    };
    for (let j = 1; j < eps.length; j++) {
      if ((eps[j].start - eps[j - 1].end) * DT <= 1.5) len++;
      else {
        close();
        len = 1;
      }
    }
    close();
  }
  // 每台
  const perBey = keys.slice(0, nb).map((key, k) => {
    const st: Record<string, number> = {};
    let floorEvents = 0;
    let floorN = 0;
    let dashN = 0;
    let brN = 0;
    let prevFloor = false;
    for (let i = 0; i < n; i++) {
      const s = STATE_NAMES[tr.v(k, i, C.state)] ?? '?';
      st[s] = (st[s] ?? 0) + 1;
      const f = tr.has(k, i, FL.floor);
      if (f) floorN++;
      if (f && !prevFloor) floorEvents++;
      prevFloor = f;
      if (tr.has(k, i, FL.dash)) dashN++;
      if (tr.has(k, i, FL.breakout)) brN++;
    }
    for (const s of Object.keys(st)) st[s] = r3(st[s] / n);
    return { key, baseTilt: r3(bases[k]), floorEvents, floorSec: r2(floorN * DT), states: st, dashSec: r2(dashN * DT), breakoutSec: r2(brN * DT) };
  });
  const fp = nb === 2 ? finishProcess(tr, fin, ex, eps) : null;
  if (fp && fin.loser !== null) fp.loserKey = keys[fin.loser];

  // 撞后倾角恢复
  const knocks: KnockEvent[] = [];
  for (let j = 0; j < eps.length; j++) {
    const s0 = eps[j].start;
    if (s0 < steps(1)) continue;
    const next = j + 1 < eps.length ? eps[j + 1].start : n;
    for (let k = 0; k < nb; k++) {
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
      knocks.push({ key: keys[k], ratio: r3(tr.v(k, s0, C.ratio)), pre: r3(pre), peak: r3(peak), recover: rec >= 0 ? r3((rec - ip) * DT) : r3((lim - ip) * DT), censored: rec < 0, rehit: rec < 0 && next < Math.min(n, ip + steps(1.5)) });
    }
  }
  // 利用失衡
  const followUps = { n: 0, hit: 0 };
  if (nb === 2)
    for (let k = 0; k < 2; k++) {
      let belowSince = 0;
      for (let i = 1; i < n; i++) {
        if (ex[k][i] < 0.25) {
          belowSince++;
          continue;
        }
        if (belowSince >= steps(1) && i > steps(1)) {
          followUps.n++;
          if (eps.some((e) => e.start > i && e.start <= i + steps(1.5))) followUps.hit++;
        }
        belowSince = 0;
      }
    }
  // 外圈切入、逼墙
  const approachDr: number[] = [];
  const wallPush = { n: 0, hit: 0 };
  if (nb === 2)
    for (const e of eps) {
      const i = Math.max(0, e.start - 6);
      const dx = tr.v(1, i, C.x) - tr.v(0, i, C.x);
      const dz = tr.v(1, i, C.z) - tr.v(0, i, C.z);
      const l = Math.hypot(dx, dz) || 1;
      const a0 = (tr.v(0, i, C.vx) * dx + tr.v(0, i, C.vz) * dz) / l; // A 朝 B 的速度
      const a1 = -(tr.v(1, i, C.vx) * dx + tr.v(1, i, C.vz) * dz) / l; // B 朝 A 的速度
      const ag = a0 >= a1 ? 0 : 1;
      const vi = 1 - ag;
      approachDr.push(r3(tr.radius(ag, i) - tr.radius(vi, i)));
      if (tr.radius(vi, e.start) < 4.4) {
        wallPush.n++;
        for (let t = e.start; t < Math.min(n, e.start + steps(0.6)); t++)
          if (tr.radius(vi, t) >= 4.4) {
            wallPush.hit++;
            break;
          }
      }
    }
  return {
    dur: r2(dur),
    keys,
    thirds,
    last10Rate,
    midRate,
    contacts: eps.length,
    longestContact: r2(longestContact),
    longestContactBearingRate: r2(bearingRate),
    longestFrozen: r2(longestFrozen),
    chains3,
    chainedShare: eps.length ? r3(chained / eps.length) : 0,
    perBey,
    finishProc: fp,
    knocks,
    followUps,
    approachDr,
    wallPush,
  };
}

// ───────────────────────────── 汇总 ─────────────────────────────

/** 一组回合的过程指标汇总（E1、E3、E5 与 AI 战术基线） */
export function summarizeProcess(ms: RoundMetrics[]) {
  const fps = ms.map((m) => m.finishProc).filter((x): x is NonNullable<RoundMetrics['finishProc']> => !!x) as Record<string, unknown>[];
  const byFinish: Record<string, unknown> = {};
  for (const f of ['spin', 'burst', 'over', 'xtreme']) {
    const g = fps.filter((x) => x.finish === f);
    if (!g.length) continue;
    const d = g.filter((x) => x.destabilized);
    const durs = d.map((x) => x.duration as number);
    const rhos = d.map((x) => x.rho).filter((x): x is number => typeof x === 'number');
    byFinish[f] = {
      n: g.length,
      destabilizedShare: r3(d.length / g.length),
      durationP25: r2(q(durs, 0.25)),
      durationP50: r2(median(durs)),
      durationP75: r2(q(durs, 0.75)),
      censored: d.filter((x) => x.censored).length,
      rhoP50: r3(median(rhos)),
      risingShare: rhos.length ? r3(rhos.filter((x) => x > 0.3).length / rhos.length) : null,
      loserExcessEndP50: r3(median(g.map((x) => x.loserExcessEnd as number))),
      winnerExcessEndP50: r3(median(g.map((x) => x.winnerExcessEnd as number))),
      winnerBelowLoser: r3(g.filter((x) => (x.winnerExcessEnd as number) < (x.loserExcessEnd as number)).length / g.length),
      onsetRatioP50: r3(median(d.map((x) => x.loserRatioAtOnset as number))),
      speedDuringOverBeforeP50: r3(median(d.map((x) => x.speedDuringOverBefore).filter((x): x is number => typeof x === 'number'))),
      floorInLast3sShare: r3(g.filter((x) => x.floorInLast3s).length / g.length),
      lastContactBeforeEndP50: r2(median(g.map((x) => x.lastContactBeforeEnd).filter((x): x is number => typeof x === 'number'))),
      hitWhileDestabShare: r3(g.filter((x) => typeof x.loserExcessAtLastContact === 'number' && (x.loserExcessAtLastContact as number) >= 0.25).length / g.length),
      sinceRatio03P50: r2(median(g.map((x) => x.sinceRatio03).filter((x): x is number => typeof x === 'number'))),
    };
  }
  const withRates = ms.filter((m) => m.last10Rate !== null && m.midRate !== null);
  const lastMid = withRates.map((m) => (m.last10Rate! + 0.05) / (m.midRate! + 0.05));
  const kn = ms.flatMap((m) => m.knocks);
  const knockBy = (lo: number, hi: number) => {
    const g = kn.filter((x) => x.ratio >= lo && x.ratio < hi);
    const done = g.filter((x) => !x.censored).map((x) => x.recover);
    return { n: g.length, recoverP50: r3(median(done)), recoverP90: r3(q(done, 0.9)), censoredShare: g.length ? r3(g.filter((x) => x.censored).length / g.length) : null, rehitShare: g.length ? r3(g.filter((x) => x.rehit).length / g.length) : null, peakP50: r3(median(g.map((x) => x.peak - x.pre))) };
  };
  const fu = ms.reduce((a, m) => ({ n: a.n + m.followUps.n, hit: a.hit + m.followUps.hit }), { n: 0, hit: 0 });
  const wp = ms.reduce((a, m) => ({ n: a.n + m.wallPush.n, hit: a.hit + m.wallPush.hit }), { n: 0, hit: 0 });
  const dr = ms.flatMap((m) => m.approachDr);
  return {
    rounds: ms.length,
    finishProcess: byFinish,
    contactRate: { last10OverMidP50: r3(median(lastMid)), last10OverMidOver2Share: lastMid.length ? r3(lastMid.filter((x) => x >= 2).length / lastMid.length) : null, rounds: lastMid.length },
    longestContactP50: r2(median(ms.map((m) => m.longestContact))),
    longestContactP90: r2(q(ms.map((m) => m.longestContact), 0.9)),
    longestContactMax: r2(Math.max(0, ...ms.map((m) => m.longestContact))),
    over3sShare: r3(ms.filter((m) => m.longestContact >= 3).length / Math.max(1, ms.length)),
    bearingRateInLongestP50: r2(median(ms.filter((m) => m.longestContact >= 0.5).map((m) => m.longestContactBearingRate))),
    longestFrozenP50: r2(median(ms.map((m) => m.longestFrozen))),
    longestFrozenMax: r2(Math.max(0, ...ms.map((m) => m.longestFrozen))),
    chains3PerRound: r3(mean(ms.map((m) => m.chains3))),
    chainedShareP50: r3(median(ms.map((m) => m.chainedShare))),
    knockRecovery: { high: knockBy(0.6, 2), mid: knockBy(0.3, 0.6), low: knockBy(0, 0.3) },
    followUp: { n: fu.n, hit: fu.hit, rate: fu.n ? r3(fu.hit / fu.n) : null },
    outerCutShare: dr.length ? r3(dr.filter((x) => x > 0.3).length / dr.length) : null,
    approachDrP50: r3(median(dr)),
    wallPush: { n: wp.n, hit: wp.hit, rate: wp.n ? r3(wp.hit / wp.n) : null },
  };
}

/** 按构筑汇总每台的阶段速度 / 半径（三等分，回合 ≥ 15 s），以及 后 1/3 ÷ 前 1/3 的比值（E2 / E4 口径的基线） */
export function phaseByKey(ms: RoundMetrics[]) {
  const acc: Record<string, { s: number[][]; r: number[][] }> = {};
  for (const m of ms) {
    if (!m.thirds) continue;
    m.keys.forEach((key, k) => {
      const a = (acc[key] ??= { s: [[], [], []], r: [[], [], []] });
      for (let t = 0; t < 3; t++) {
        a.s[t].push(m.thirds!.speed[k][t]);
        a.r[t].push(m.thirds!.r[k][t]);
      }
    });
  }
  const out: Record<string, unknown> = {};
  for (const [key, a] of Object.entries(acc)) {
    const s = a.s.map(median);
    const r = a.r.map(median);
    out[key] = { n: a.s[0].length, speed: s.map(r3), radius: r.map(r3), lateOverEarlySpeed: r3(s[2] / s[0]), lateOverEarlyRadius: r3(r[2] / r[0]) };
  }
  return out;
}

/** 按构筑汇总意图状态时间占比、触地、冲刺、脱困 */
export function beyByKey(ms: RoundMetrics[]) {
  const acc: Record<string, { n: number; states: Record<string, number>; floorEv: number; floorSec: number; dash: number; br: number; base: number[] }> = {};
  for (const m of ms)
    for (const b of m.perBey) {
      const a = (acc[b.key] ??= { n: 0, states: {}, floorEv: 0, floorSec: 0, dash: 0, br: 0, base: [] });
      a.n++;
      for (const [s, v] of Object.entries(b.states)) a.states[s] = (a.states[s] ?? 0) + v;
      a.floorEv += b.floorEvents;
      a.floorSec += b.floorSec;
      a.dash += b.dashSec;
      a.br += b.breakoutSec;
      a.base.push(b.baseTilt);
    }
  const out: Record<string, unknown> = {};
  for (const [key, a] of Object.entries(acc))
    out[key] = {
      sides: a.n,
      baseTiltP50: r3(median(a.base)),
      states: Object.fromEntries(Object.entries(a.states).map(([s, v]) => [s, r3(v / a.n)])),
      floorEventsPerRound: r3(a.floorEv / a.n),
      floorSecPerRound: r3(a.floorSec / a.n),
      dashSecPerRound: r3(a.dash / a.n),
      breakoutSecPerRound: r3(a.br / a.n),
    };
  return out;
}
