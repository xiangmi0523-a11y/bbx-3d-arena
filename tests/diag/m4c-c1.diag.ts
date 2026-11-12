/// <reference types="node" />
/**
 * M4-C · C1 预算诊断（扩充版，只读）——方案见 docs/engineering/m4c-c1-plan.md。
 *
 * 通过 EXECUTOR_PROBE（只读探针，零行为变化由 tests/executor.test.ts 证明）拿到每一步执行层各阶段的中间量，
 * 通过 ContactService 拿到接地法向力（滞后一拍的 N_lag 与同一步的 N_post）、接触点和接触段生命周期。
 * 不改任何默认参数、AI、规则；不产出最终参数、不设通过门槛。
 *
 * 样本：S1 = 签名矩阵筛选集 matrixScenarios(20000, 20)（320 回合）；S2 = M4-A 单台套件（36 台，最长 150 s）。
 * 输出（行首 MC1-，同时写入 test-results/diag-out.jsonl）：
 *   MC1-META   各构筑的质量 / 惯量 / 几何（I_a = spinInertia 与 massProps.Ia 并列）
 *   MC1-AGG    每个“样本 | 构筑”的分布（P10 / P25 / P50 / P75 / P90 / 均值 / n）与计数
 *   MC1-ROUND  每回合每台一行：账本、能量形式的折算、一阶时长投影
 *   MC1-CONTACT 接触段持续时间分布（按对阵 / 构筑）
 *   MC1-DONE   耗时
 * 运行：npx vitest run --config vitest.diag.config.ts tests/diag/m4c-c1.diag.ts
 */
import { test } from 'vitest';
import { ARENA, floorNormal } from '../../src/game/arena/arenaSpec';
import { FINISH_TUNING } from '../../src/game/battle/BattleSystem';
import { BEY_TUNING, type BeyPhysics, type SpinLedger } from '../../src/game/beys/BeyPhysics';
import { EXECUTOR_PROBE, type ExecutorHost, type ExecutorProbe, type ExecFrame, type TractionProbe } from '../../src/game/beys/motionExecutor';
import { BEY_COLLIDER_PARTS, type ContactService } from '../../src/game/physics/ContactService';
import { loadRapier, PHYSICS_DT, type PhysicsWorld } from '../../src/game/physics/PhysicsWorld';
import { BITS, SIGNATURE_LIST } from '../../src/game/beys/parts/catalog';
import { POW, soloSuite } from './m4.runs';
import { matrixScenarios, out, runRound } from './m5b.shared';

const DT = PHYSICS_DT;
const T = BEY_TUNING;
/** 撞击后窗口与“典型”判定的回看长度：0.5 s */
const WIN = Math.round(0.5 / DT);
/** 分布数组每 2 步记 1 次（计数与求和每步都算） */
const STRIDE = 2;
const MU_GRID = [0.1, 0.2, 0.3, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
const K_FIXED = [1, 3, 10];
const D_NAMES = ['geo', 'drift', 'rim'] as const;
type DName = (typeof D_NAMES)[number];

// ───────────────────────────── 汇总容器 ─────────────────────────────

class Agg {
  readonly d: Record<string, number[]> = {};
  readonly c: Record<string, number> = {};
  push(name: string, v: number) {
    if (Number.isFinite(v)) (this.d[name] ??= []).push(v);
  }
  inc(name: string, k = 1) {
    this.c[name] = (this.c[name] ?? 0) + k;
  }
}
const aggs = new Map<string, Agg>();
const agg = (k: string) => {
  let a = aggs.get(k);
  if (!a) aggs.set(k, (a = new Agg()));
  return a;
};

function quant(a: number[]) {
  if (!a.length) return { n: 0 };
  const s = Float64Array.from(a).sort();
  const q = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
  let sum = 0;
  for (const v of s) sum += v;
  const f = (v: number) => (Math.abs(v) >= 100 ? Math.round(v * 10) / 10 : Math.round(v * 10000) / 10000);
  return { n: s.length, p10: f(q(0.1)), p25: f(q(0.25)), p50: f(q(0.5)), p75: f(q(0.75)), p90: f(q(0.9)), p99: f(q(0.99)), mean: f(sum / s.length) };
}

// ───────────────────────────── 每台的逐步跟踪 ─────────────────────────────

/** 本步探针写入的中间量 */
interface Scratch {
  tr: boolean;
  elig: boolean;
  applied: boolean;
  j: number;
  dx: number;
  dz: number;
  vx: number;
  vz: number;
  along: number;
  cap: number;
  grip: number;
  edgeHelps: boolean;
  explicit: boolean;
  mag: number;
  railW: number;
  railJ: number;
  rollW: number;
  pd: boolean;
  s: number;
  sRaw: number;
  dpx: number;
  dpy: number;
  dpz: number;
  px0: number;
  py0: number;
  pz0: number;
  magP: number;
}
const newScratch = (): Scratch => ({ tr: false, elig: false, applied: false, j: 0, dx: 0, dz: 0, vx: 0, vz: 0, along: 0, cap: 0, grip: 0, edgeHelps: true, explicit: true, mag: 0, railW: 0, railJ: 0, rollW: 0, pd: false, s: 0, sRaw: 0, dpx: 0, dpy: 0, dpz: 0, px0: 0, py0: 0, pz0: 0, magP: 0 });

const LEDGER_KEYS: (keyof SpinLedger)[] = ['base', 'scrape', 'rail', 'drive', 'steer', 'burst', 'air', 'smash', 'claw', 'contactLoss', 'contactGain'];

class Track {
  readonly key: string;
  readonly side: string;
  readonly bey: BeyPhysics;
  readonly m: number;
  readonly Ia: number;
  readonly It: number;
  readonly rho: number;
  readonly l: number;
  readonly drift: number;
  readonly w0: number;
  sc = newScratch();
  step = 0;
  prevSpin: number;
  prevDrive = 0;
  /** 账本各分项上一步的值与折算成能量的累计 Σ I_a·ω·Δω_分项（ω 取该步扣除前的转速） */
  readonly prevLedger: Record<string, number> = {};
  readonly eLedger: Record<string, number> = {};
  // 一阶投影：ω′（牵引按功率形式 η = 1），ω″（牵引 + 姿态）
  wP: number;
  wPP: number;
  tP = -1;
  tPP = -1;
  lastContact = -1e9;
  impactUntil = -1;
  impactPeak = 0;
  bitGapStart = -1;
  readonly e = { WtrPos: 0, WtrNeg: 0, dwP: 0, dwTau: { geo: 0, drift: 0, rim: 0 } as Record<DName, number>, WrailPos: 0, dwPrail: 0, WpdPos: 0, WpdNeg: 0, PpdPos: 0, dwPd: 0, Wroll: 0, appliedSteps: 0, pdSteps: 0, steps: 0 };
  constructor(key: string, side: string, bey: BeyPhysics) {
    this.key = key;
    this.side = side;
    this.bey = bey;
    this.m = bey.body.mass();
    this.Ia = bey.spec.spinInertia;
    this.It = bey.massProps.It;
    this.rho = bey.spec.bit.contactRadius;
    this.l = bey.massProps.comY - this.rho;
    this.drift = bey.spec.bit.drift;
    this.w0 = bey.launchSpin;
    this.prevSpin = bey.spin;
    this.wP = bey.spin;
    this.wPP = bey.spin;
  }
}

const tracks = new Map<ExecutorHost, Track>();

/** 只读探针：只把数值写进对应台的 Scratch，不调用 Rapier */
const PROBE: ExecutorProbe = {
  rail(h, dx, dz, accel, m, dt, vx, vz) {
    const t = tracks.get(h);
    if (!t) return;
    const jx = dx * accel * m * dt;
    const jz = dz * accel * m * dt;
    t.sc.railJ = Math.hypot(jx, jz);
    t.sc.railW = jx * vx + jz * vz + (jx * jx + jz * jz) / (2 * m);
  },
  traction(h, p: TractionProbe) {
    const t = tracks.get(h);
    if (!t) return;
    const s = t.sc;
    s.tr = true;
    s.elig = p.eligible;
    s.applied = p.applied;
    s.j = p.j;
    s.dx = p.dx;
    s.dz = p.dz;
    s.vx = p.vx;
    s.vz = p.vz;
    s.along = p.along;
    s.cap = p.cap;
    s.grip = p.driveGrip;
    s.edgeHelps = p.edgeHelps;
    s.explicit = p.explicit;
    s.mag = p.mag;
  },
  rolling(h, vx, vz, sp, dv, m) {
    const t = tracks.get(h);
    if (!t) return;
    const jx = (-vx / sp) * dv * m;
    const jz = (-vz / sp) * dv * m;
    t.sc.rollW = jx * vx + jz * vz + (jx * jx + jz * jz) / (2 * m);
  },
  posture(h, f: ExecFrame, s, _lean, px0, py0, pz0) {
    const t = tracks.get(h);
    if (!t) return;
    const c = t.sc;
    c.pd = s > 0;
    c.s = s;
    c.sRaw = Math.max(0, Math.min(1, (f.mag - T.minStableSpin) / (h.launchSpin * 0.3)));
    c.px0 = px0;
    c.py0 = py0;
    c.pz0 = pz0;
    c.dpx = f.px - px0;
    c.dpy = f.py - py0;
    c.dpz = f.pz - pz0;
    c.magP = f.mag;
  },
};

const band = (ratio: number) => (ratio >= 0.6 ? 'hi' : ratio >= 0.3 ? 'mid' : 'lo');

/**
 * 一步结束后（ContactService 已观测本步）处理一台：读状态（只读）、按定义累计。
 * postLaunch：S1 用意图离开 launch，S2 用发射后 1 s（单台没有对手，意图不更新）。
 */
function afterStep(t: Track, cs: ContactService | null, sample: string, postLaunch: boolean, bodyContact: boolean, impactBegin: boolean) {
  const bey = t.bey;
  const A = agg(`${sample}|${t.key}`);
  const s = t.sc;
  const k = t.step++;
  const rec = k % STRIDE === 0;
  const spin = bey.spin;
  const ratio = Math.min(1, spin / t.w0);
  const b = band(ratio);
  const g = bey.pw.g;

  // ── 投影与能量（发射过渡也计入，只排除爆裂后）──
  for (const kk of LEDGER_KEYS) {
    const cur = bey.ledger[kk];
    const d = cur - (t.prevLedger[kk] ?? 0);
    if (d !== 0) t.eLedger[kk] = (t.eLedger[kk] ?? 0) + t.Ia * Math.max(0, t.prevSpin) * d;
    t.prevLedger[kk] = cur;
  }
  const dDrive = bey.ledger.drive - t.prevDrive;
  const dw = spin - t.prevSpin;
  t.prevDrive = bey.ledger.drive;
  t.prevSpin = spin;
  let Wtr = 0;
  if (!bey.bursted) {
    if (s.applied) {
      const jx = s.dx * s.j;
      const jz = s.dz * s.j;
      Wtr = jx * s.vx + jz * s.vz + (jx * jx + jz * jz) / (2 * t.m);
      if (Wtr >= 0) t.e.WtrPos += Wtr;
      else t.e.WtrNeg += Wtr;
      const wref = Math.max(1e-3, s.mag);
      t.e.dwP += Math.max(0, Wtr) / (t.Ia * wref);
      t.e.appliedSteps++;
    }
    if (s.railJ > 0) {
      t.e.WrailPos += Math.max(0, s.railW);
      t.e.dwPrail += Math.max(0, s.railW) / (t.Ia * Math.max(1e-3, s.mag || spin));
    }
    t.e.Wroll += s.rollW;
    let dKE = 0;
    if (s.pd) {
      const dot = s.px0 * s.dpx + s.py0 * s.dpy + s.pz0 * s.dpz;
      const d2 = s.dpx * s.dpx + s.dpy * s.dpy + s.dpz * s.dpz;
      dKE = t.It * (dot + 0.5 * d2);
      if (dKE >= 0) t.e.WpdPos += dKE;
      else t.e.WpdNeg += dKE;
      t.e.PpdPos += Math.max(0, t.It * dot);
      t.e.dwPd += Math.max(0, dKE) / (t.Ia * Math.max(1e-3, s.magP));
      t.e.pdSteps++;
    }
    t.e.steps++;
    const nonDrive = dw + dDrive;
    t.wP = Math.max(0, t.wP + nonDrive - Math.max(0, Wtr) / (t.Ia * Math.max(1, t.wP)));
    t.wPP = Math.max(0, t.wPP + nonDrive - (Math.max(0, Wtr) + Math.max(0, dKE)) / (t.Ia * Math.max(1, t.wPP)));
    if (t.tP < 0 && t.wP < FINISH_TUNING.stopSpin) t.tP = (k + 1) * DT;
    if (t.tPP < 0 && t.wPP < FINISH_TUNING.stopSpin) t.tPP = (k + 1) * DT;
  }

  // ── 几何与接触（只读）──
  const body = bey.body;
  const pos = body.translation();
  const up = bey.up();
  const r = Math.hypot(pos.x, pos.z);
  const n = r <= ARENA.radius ? floorNormal(pos.x, pos.z) : [0, 1, 0];
  const cosRel = Math.max(-1, Math.min(1, up.x * n[0] + up.y * n[1] + up.z * n[2]));
  const thetaRel = Math.acos(cosRel);
  const sinRel = Math.sin(thetaRel);
  const v = body.linvel();
  const speed = Math.hypot(v.x, v.z);
  const nLag = bey.load.valid ? bey.load.N : NaN;
  const pair = cs?.colliderPair(`${t.side}:bit`, 'arena:floor') ?? null;
  const nPost = pair && cs && pair.seenStep === cs.step ? pair.normalImpulse / DT : 0;

  if (bodyContact) t.lastContact = k;
  if (impactBegin) {
    if (t.impactUntil > k) A.push('g2.impactPeakTilt', t.impactPeak);
    t.impactUntil = k + WIN;
    t.impactPeak = 0;
  }
  const inImpact = k <= t.impactUntil;
  if (inImpact) t.impactPeak = Math.max(t.impactPeak, thetaRel);
  else if (t.impactUntil >= 0 && k === t.impactUntil + 1) A.push('g2.impactPeakTilt', t.impactPeak);

  // ── 接触段：轴心离地间隙、非轴心部件触地、撞墙（ContactService 生命周期事件）──
  if (cs) {
    for (const ev of cs.events) {
      if (ev.level !== 'collider') continue;
      const [a, bb] = ev.key.split('|');
      const mine = a.startsWith(`${t.side}:`) ? a : bb.startsWith(`${t.side}:`) ? bb : null;
      if (!mine) continue;
      const other = mine === a ? bb : a;
      const part = mine.split(':')[1];
      if (other === 'arena:floor') {
        if (part === 'bit') {
          if (ev.kind === 'end') t.bitGapStart = ev.step;
          else if (t.bitGapStart >= 0) {
            A.push('g5.bitAirSteps', ev.step - t.bitGapStart);
            t.bitGapStart = -1;
          }
        } else if (ev.kind === 'end') A.push(`g5.floor.${part}Steps`, ev.durationSteps);
      } else if (other.startsWith('arena:wall') && ev.kind === 'end') A.push('g5.wallSteps', ev.durationSteps);
    }
  }

  if (bey.bursted || !postLaunch) return;
  A.inc('steps');
  if (bey.grounded) {
    A.inc('grounded');
    if (bey.load.valid && nLag === 0) A.inc('groundedNlag0');
    if (nPost === 0) A.inc('groundedNpost0');
    if (bey.load.valid && nLag > 0 !== nPost > 0) A.inc('lagMismatch');
    if (rec && bey.load.valid && nLag > 0 && nPost > 0) A.push('g1.nLagOverPost', nLag / nPost);
    if (rec && bey.load.valid) A.push('g1.nLagOverMg', nLag / (t.m * g));
  } else A.inc('notGrounded');

  // ── 2.1 / 2.4 牵引 ──
  if (s.tr) {
    if (s.elig) {
      A.inc('eligible');
      if (!s.edgeHelps) A.inc('cur.edgeBlocked');
      else if (s.explicit && s.along >= s.cap) A.inc('cur.capBind');
    } else if (bey.grounded) {
      if (bey.dashing) A.inc('inelig.dashing');
      else if (s.grip < T.driveMinGrip) A.inc('inelig.lowGrip');
      else if (s.mag <= T.minStableSpin * 2) A.inc('inelig.lowSpin');
      else A.inc('inelig.other');
    }
  }
  if (s.applied) {
    A.inc('applied');
    const F = s.j / DT;
    const ny = n[1];
    if (bey.load.valid && nLag === 0) A.inc('applied.Nlag0');
    if (nPost === 0) A.inc('applied.Npost0');
    if (rec) {
      if (bey.load.valid && nLag > 0) {
        A.push('g1.muLag', F / nLag);
        A.push(`g1.muLag.${b}`, F / nLag);
      }
      A.push('g1.muStatic', F / (t.m * g * ny));
      A.push(`g1.muStatic.${b}`, F / (t.m * g * ny));
    }
    for (const mu of MU_GRID) if (!(bey.load.valid && F <= mu * nLag)) A.inc(`bind.mu${mu}`);
    const dset: Record<DName, number> = { geo: t.rho * sinRel, drift: t.rho * Math.sin(t.drift), rim: t.rho };
    for (const dn of D_NAMES) {
      if (s.along >= s.mag * dset[dn]) A.inc(`bind.wd.${dn}`);
      t.e.dwTau[dn] += (s.j * dset[dn]) / t.Ia;
    }
    if (rec) {
      A.push('g3.Wtr', Wtr / DT);
      if (Wtr > 0) for (const dn of D_NAMES) A.push(`g3.etaImplied.${dn}`, Wtr / (s.j * s.mag * dset[dn]));
      A.push('g2.applied.along', s.along);
    }
  }

  // ── 2.1 / 2.4 姿态 ──
  if (s.pd || s.tr) {
    A.inc('postureSteps');
    if (s.pd) {
      A.inc('pd');
      if (s.sRaw >= 1) A.inc('pd.sat');
      else A.inc('pd.tail');
      const dwn = Math.hypot(s.dpx, s.dpy, s.dpz);
      const tau = (t.It * dwn) / DT;
      const L = t.Ia * Math.max(1e-3, s.magP);
      const K = tau / L;
      const omegaP = (t.m * g * t.l) / L;
      const omegaSyn = T.precessBase + T.precessSpin / Math.max(20, s.magP);
      if (K > omegaP) A.inc('bind.K.Op');
      if (K > omegaSyn) A.inc('bind.K.Osyn');
      for (const kf of K_FIXED) if (K > kf) A.inc(`bind.K.${kf}`);
      if (rec) {
        A.push('g1.K', K);
        A.push(`g1.K.${b}`, K);
        A.push('g1.tauPD', tau);
        A.push('g1.OmegaP', omegaP);
        A.push('g1.OmegaSyn', omegaSyn);
        A.push('g1.cgP', K / omegaP);
        A.push('g1.cgSyn', K / omegaSyn);
        const wperp = Math.hypot(s.px0, s.py0, s.pz0);
        A.push('g1.wperp', wperp);
        A.push('g3.Ppd', (t.It * (s.px0 * s.dpx + s.py0 * s.dpy + s.pz0 * s.dpz)) / DT);
      }
    }
  }

  // ── 2.2 d_eff 与 ω·d（典型 / 撞击后）──
  if (bey.grounded && rec) {
    const win = inImpact ? 'imp' : k - t.lastContact > WIN ? 'typ' : null;
    if (win) {
      const w = spin;
      let dmeas = NaN;
      if (pair && cs && pair.seenStep === cs.step && pair.deepest) {
        const cx = pos.x + up.x * t.rho;
        const cy = pos.y + up.y * t.rho;
        const cz = pos.z + up.z * t.rho;
        const px = pair.deepest.x - cx;
        const py = pair.deepest.y - cy;
        const pz = pair.deepest.z - cz;
        const along = px * up.x + py * up.y + pz * up.z;
        dmeas = Math.hypot(px - along * up.x, py - along * up.y, pz - along * up.z);
      }
      const pre = `g2.${win}`;
      A.push(`${pre}.theta`, thetaRel);
      A.push(`${pre}.theta.${b}`, thetaRel);
      A.push(`${pre}.omega.${b}`, w);
      A.push(`${pre}.dgeo`, t.rho * sinRel);
      A.push(`${pre}.dmeas`, dmeas);
      A.push(`${pre}.dmeasMinusGeo`, dmeas - t.rho * sinRel);
      A.push(`${pre}.wdGeo.${b}`, w * t.rho * sinRel);
      A.push(`${pre}.wdDrift.${b}`, w * t.rho * Math.sin(t.drift));
      A.push(`${pre}.wdRim.${b}`, w * t.rho);
      A.push(`${pre}.speed.${b}`, speed);
      if (s.elig) {
        A.push(`${pre}.along.${b}`, s.along);
        A.push(`${pre}.cap.${b}`, s.cap);
      }
      A.push(`${pre}.tauG`, t.m * g * t.l * sinRel);
      A.push(`${pre}.wperp`, Math.hypot(s.px0, s.py0, s.pz0));
    }
  }
}

function roundSummary(t: Track) {
  const L = t.bey.ledger;
  const led: Record<string, number> = {};
  for (const kk of LEDGER_KEYS) led[kk] = Math.round(L[kk] * 1000) / 1000;
  const e = t.e;
  const r4 = (v: number) => Math.round(v * 10000) / 10000;
  return {
    key: t.key,
    side: t.side,
    w0: r4(t.w0),
    wEnd: r4(t.bey.spin),
    E0: r4(0.5 * t.Ia * t.w0 * t.w0),
    ledger: led,
    eLedger: Object.fromEntries(Object.entries(t.eLedger).map(([kk, v]) => [kk, Math.round(v * 1000) / 1000])),
    WtrPos: r4(e.WtrPos),
    WtrNeg: r4(e.WtrNeg),
    dwP: r4(e.dwP),
    dwTau: { geo: r4(e.dwTau.geo), drift: r4(e.dwTau.drift), rim: r4(e.dwTau.rim) },
    WrailPos: r4(e.WrailPos),
    dwPrail: r4(e.dwPrail),
    WpdPos: r4(e.WpdPos),
    WpdNeg: r4(e.WpdNeg),
    PpdPosDt: r4(e.PpdPos),
    dwPd: r4(e.dwPd),
    Wroll: r4(e.Wroll),
    applied: e.appliedSteps,
    pd: e.pdSteps,
    steps: e.steps,
    wP: r4(t.wP),
    wPP: r4(t.wPP),
    tP: t.tP,
    tPP: t.tPP,
  };
}

// ───────────────────────────── 接触段（身体级，两台之间）─────────────────────────────

const contactAgg = new Map<string, number[]>();
const pushC = (k: string, v: number) => (contactAgg.get(k) ?? contactAgg.set(k, []).get(k)!).push(v);

test('M4-C C1 预算诊断（只读）', async () => {
  const R = await loadRapier();
  const t0 = Date.now();
  EXECUTOR_PROBE.on = PROBE;
  try {
    // ── S1：签名矩阵筛选集 ──
    const scs = matrixScenarios(20000, 20);
    for (const sc of scs) {
      tracks.clear();
      let A: Track | null = null;
      let B: Track | null = null;
      let roundSteps = 0;
      const matchup = sc.name.split('#')[0];
      const rec = runRound(
        R,
        sc,
        (ctx) => {
          const cs = ctx.pw.contacts;
          roundSteps++;
          let bodyContact = false;
          let impactBegin = false;
          if (cs) {
            const bp = cs.bodyPair('player', 'rival');
            bodyContact = !!bp?.physicalContact;
            for (const ev of cs.events) {
              if (ev.level !== 'body') continue;
              const ks = ev.key.split('|');
              if (!(ks.includes('player') && ks.includes('rival'))) continue;
              if (ev.kind === 'begin') impactBegin = true;
              else {
                pushC(`S1|${matchup}`, ev.durationSteps);
                pushC(`S1|all`, ev.durationSteps);
              }
            }
          }
          for (const [t, bey] of [
            [A!, ctx.A],
            [B!, ctx.B],
          ] as const) {
            afterStep(t, cs, 'S1', bey.intent.state !== 'launch', bodyContact, impactBegin);
            t.sc = newScratch();
          }
        },
        (ctx, rr) => {
          const cs = ctx.pw.contacts;
          const bp = cs?.bodyPair('player', 'rival');
          if (bp && bp.phase !== 'none') {
            pushC(`S1|${matchup}|open`, bp.durationSteps);
            pushC(`S1|${matchup}`, bp.durationSteps);
            pushC(`S1|all`, bp.durationSteps);
          }
          pushC(`S1|${matchup}|roundSteps`, roundSteps);
          for (const t of [A!, B!]) {
            const own = (t.side === 'player' ? rr.sides[0] : rr.sides[1]).won;
            out('MC1-ROUND', { sample: 'S1', scn: sc.name, seed: sc.seed, dur: rr.dur, finish: rr.finish, kind: rr.kind, won: own, ...roundSummary(t) });
          }
        },
        (ctx) => {
          A = new Track(sc.name.split('-')[0], 'player', ctx.A);
          B = new Track(sc.name.split('-')[1].split('#')[0], 'rival', ctx.B);
          tracks.set(ctx.A, A);
          tracks.set(ctx.B, B);
        },
      );
      void rec;
    }

    // ── S2：单台套件（只为观测登记主体名；单台没有 BattleSystem）──
    // soloSuite 的运行顺序（与 m4.runs.ts 相同）：4 签名 × 3 力度 × 2 种子，然后森衡刀刃 / 棘轮 × 各轴心 × 3 种子
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
        const t = new Track(names[idx++] ?? '?', 'player', bey);
        tracks.set(bey, t);
        let k = 0;
        const prev = pw.afterStep;
        pw.afterStep = (dt) => {
          prev?.(dt);
          k++;
          afterStep(t, cs, 'S2', k * DT >= 1, false, false);
          t.sc = newScratch();
        };
        return () => t;
      },
    });
    for (const sr of solo.recs) {
      const t = sr.instr as Track;
      if (t.key !== sr.name) throw new Error(`单台顺序不一致：${t.key} ≠ ${sr.name}`);
      out('MC1-ROUND', { sample: 'S2', scn: `${sr.name}@${sr.power}#${sr.seed}`, seed: sr.seed, dur: sr.endAt, finish: sr.end, kind: 'solo', won: null, ...roundSummary(t) });
    }
  } finally {
    EXECUTOR_PROBE.on = null;
  }

  // ── META：各构筑的质量与几何 ──
  const meta: Record<string, unknown> = {};
  // 由 ROUND 记录无法反推的常量：用一台新建的陀螺读取（只读）
  {
    const sc = matrixScenarios(20000, 1);
    for (const s of sc.filter((x) => x.name.split('-')[0] === x.name.split('-')[1].split('#')[0])) {
      runRound(R, { ...s, maxSeconds: 0.05 }, undefined, (ctx) => {
        const b = ctx.A;
        const key = s.name.split('-')[0];
        meta[key] = {
          bodyMass: b.body.mass(),
          totalMass: b.spec.totalMass,
          spinInertia: b.spec.spinInertia,
          massPropsIa: b.massProps.Ia,
          IaRatio: b.spec.spinInertia / b.massProps.Ia,
          It: b.massProps.It,
          comY: b.massProps.comY,
          rho: b.spec.bit.contactRadius,
          l: b.massProps.comY - b.spec.bit.contactRadius,
          drift: b.spec.bit.drift,
          gearGrip: b.spec.bit.gearGrip,
          friction: b.spec.bit.friction,
          spinDecay: b.spec.bit.spinDecay,
          maxSpin: b.spec.maxSpin,
          launchSpin: b.launchSpin,
          g: b.pw.g,
        };
      });
    }
  }
  out('MC1-META', meta);
  for (const [k, a] of [...aggs.entries()].sort()) {
    const dists: Record<string, unknown> = {};
    for (const [nm, arr] of Object.entries(a.d).sort()) dists[nm] = quant(arr);
    out('MC1-AGG', { key: k, counts: a.c, dists });
  }
  for (const [k, arr] of [...contactAgg.entries()].sort()) {
    if (k.endsWith('|roundSteps')) {
      out('MC1-CONTACT', { key: k, roundSteps: arr.reduce((x, y) => x + y, 0), rounds: arr.length });
      continue;
    }
    const long = (th: number) => arr.filter((v) => v >= th).length;
    out('MC1-CONTACT', {
      key: k,
      episodes: arr.length,
      totalSteps: arr.reduce((x, y) => x + y, 0),
      ge05s: long(60),
      ge1s: long(120),
      ge2s: long(240),
      max: arr.length ? Math.max(...arr) : 0,
      q: quant(arr),
    });
  }
  out('MC1-DONE', { ms: Date.now() - t0, aggs: aggs.size });
}, 3600000);
