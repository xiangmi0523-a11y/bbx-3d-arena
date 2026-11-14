import { describe, expect, it } from 'vitest';
import golden from './fixtures/repro-golden.json';
import { scenariosV2, setup, type Scn } from './diag/stallprobe2.shared';
import { matrixScenarios } from './diag/m5b.shared';
import { compareTraces, summarize, type TraceSummary } from './repro/compare';
import { configSnapshot } from './repro/config';
import { rapier, recordRun } from './repro/recorder';
import { withDeterminism } from './repro/determinism';
import { BEY_TUNING, BeyPhysics } from '../src/game/beys/BeyPhysics';
import { EXECUTOR_PROBE, EXECUTOR_SWITCH, EXECUTOR_TUNING, POSTURE_BUDGET, newExecFrame, readTipLoad, newLoadSample, stepPosture, stepTraction, type ExecutorHost, type ExecutorProbe, type ExecFrame } from '../src/game/beys/motionExecutor';
import { assembleBey } from '../src/game/beys/parts/assemble';
import { SIGNATURE_LIST } from '../src/game/beys/parts/catalog';
import { createArenaPhysics } from '../src/game/arena/ArenaPhysics';
import { floorHeight } from '../src/game/arena/arenaSpec';
import { GYRO_EXPERIMENT } from '../src/game/physics/gyro';
import { PHYSICS_DT, PHYSICS_EXPERIMENT, PhysicsWorld } from '../src/game/physics/PhysicsWorld';

/**
 * M4-C · C0 运动执行层拆分（零行为变化）的验收测试。docs/engineering/m4c-c0-acceptance.md 逐项对应：
 *  1. 开关与参数：默认走执行层；EXECUTOR_TUNING 独立、不进参数指纹（指纹本身由 repro.test 对 golden 检查）；
 *  2. 回滚：EXECUTOR_SWITCH.legacy = 1（原样保留的旧 preStep）与 golden 逐场一致（REPRO_FULL=1 时全部 180 场）；
 *  3. 执行顺序与中间状态读取：新旧两条路径并排推进，逐步记录两台陀螺刚体上的每一次读写调用（方法、参数、返回值），序列逐位相同；
 *     场景强制覆盖轨道冲刺、脱困方向、墙边借用咬合（edgeOnly）、tiltDrive / 去掉显式牵引 / 去掉 PD、PD 饱和与尾段、刮地开 / 关；
 *  4. 分支语义（执行层阶段函数单测，假刚体）：牵引门限、edgeOnly、脱困方向、tiltDrive、PD 饱和与尾段；刮地开关（BeyPhysics 级）；
 *  5. 接地法向力 N：来自 ContactService 上一子步的轴心-地面法向冲量 / dt，滞后一拍（含 2 子步时按子步滞后）；无观测时无效。
 */

type R = Awaited<ReturnType<typeof rapier>>;
const G = golden as unknown as { config: string; runs: TraceSummary[] };
const behavior = (s: TraceSummary): TraceSummary => ({ ...s, config: '' });

function withSwitch<T>(legacy: number, fn: () => T): T {
  const old = EXECUTOR_SWITCH.legacy;
  EXECUTOR_SWITCH.legacy = legacy;
  try {
    return fn();
  } finally {
    EXECUTOR_SWITCH.legacy = old;
  }
}

function withGyro<T>(x: Partial<typeof GYRO_EXPERIMENT>, fn: () => T): T {
  const old = { ...GYRO_EXPERIMENT };
  Object.assign(GYRO_EXPERIMENT, x);
  try {
    return fn();
  } finally {
    Object.assign(GYRO_EXPERIMENT, old);
  }
}

describe('C0 开关、参数与回滚', () => {
  it('默认走执行层；EXECUTOR_TUNING 独立且为空（C0 不引入新参数）；参数快照里没有执行层开关', async () => {
    expect(EXECUTOR_SWITCH.legacy).toBe(0);
    expect(Object.keys(EXECUTOR_TUNING)).toEqual([]);
    const R = await rapier();
    const snap = JSON.stringify(configSnapshot(R));
    expect(snap.includes('"legacy"')).toBe(false);
    expect(Object.keys(configSnapshot(R))).not.toContain('executor');
  });

  it(`回滚：旧 preStep 路径（legacy = 1）与 golden 逐场一致（${process.env.REPRO_FULL ? '全部 180 场' : '每组第一场'}）`, async () => {
    const R = await rapier();
    const all = scenariosV2();
    const list = process.env.REPRO_FULL ? all : all.filter((s, i) => all.findIndex((x) => x.group === s.group) === i);
    const runs = withSwitch(1, () => list.map((sc) => summarize(recordRun(R, sc, { keyframes: false }))));
    const want = G.runs.filter((g) => list.some((s) => s.name === g.name));
    const rep = compareTraces(runs.map(behavior), want.map(behavior));
    expect(rep.missing).toEqual([]);
    expect(rep.diffs, JSON.stringify(rep.diffs.slice(0, 3), null, 1)).toEqual([]);
    expect(rep.identical).toBe(list.length);
  }, 600000);
});

// ───────────────────────── 并排推进：调用序列逐位相同 ─────────────────────────

/** FNV-1a 64 位（字符串），逐步比较调用序列 */
function fnv(s: string, h = 0xcbf29ce484222325n): bigint {
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h;
}

const LOGGED = ['translation', 'linvel', 'angvel', 'rotation', 'mass', 'applyImpulse', 'setAngvel', 'enableCcd', 'setLinvel', 'setTranslation', 'setRotation'] as const;

/** 给刚体的读写方法包一层记录（只记录，不改参数与返回值） */
function tap(bey: BeyPhysics, tag: string, log: string[]) {
  const body = bey.body as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const m of LOGGED) {
    const orig = body[m].bind(body);
    body[m] = (...args: unknown[]) => {
      const out = orig(...args);
      log.push(`${tag}.${m}(${JSON.stringify(args)})=${JSON.stringify(out ?? null)}`);
      return out;
    };
  }
}

interface Cover {
  dash: number;
  breakoutDrive: number;
  edgeOnly: number;
  pdSat: number;
  pdTail: number;
  pdOff: number;
  scrape: number;
}

/**
 * 两个相同的世界并排推进：A 走执行层、B 走旧路径。每个物理步把两边刚体上的全部读写调用（含参数与返回值）按顺序记录，
 * 逐步比较哈希；最后比较完整状态。perturb 在两边同一步做同样的测试摆放（只用于强制进入某个分支）。
 */
function lockstep(
  R: R,
  sc: Scn,
  frames: number,
  perturb?: (step: number, b: ReturnType<typeof setup>) => void,
  /** C1：只在 A 的物理步期间安装的只读探针；afterA 在 A 这一步结束后拿到 A 的调用记录（用于核对探针报告的冲量） */
  probe?: { make: (A: ReturnType<typeof setup>) => ExecutorProbe; afterA: (log: string[]) => void },
): Cover {
  const mk = () => withDeterminism(sc.seed, () => setup(R, sc, { observeContacts: true })).value;
  const A = mk();
  const B = mk();
  const logA: string[] = [];
  const logB: string[] = [];
  tap(A.A, 'p', logA);
  tap(A.B, 'r', logA);
  tap(B.A, 'p', logB);
  tap(B.B, 'r', logB);
  const cover: Cover = { dash: 0, breakoutDrive: 0, edgeOnly: 0, pdSat: 0, pdTail: 0, pdOff: 0, scrape: 0 };
  const T = BEY_TUNING;
  let pa: ExecutorProbe | undefined;
  for (let s = 0; s < frames && !A.b.result && !B.b.result; s++) {
    perturb?.(s, A);
    perturb?.(s, B);
    logA.length = 0;
    logB.length = 0;
    if (probe) {
      EXECUTOR_PROBE.on = pa ??= probe.make(A);
      try {
        withSwitch(0, () => A.pw.step());
      } finally {
        EXECUTOR_PROBE.on = null;
      }
      probe.afterA(logA);
    } else withSwitch(0, () => A.pw.step());
    withSwitch(1, () => B.pw.step());
    const ha = fnv(logA.join('\n'));
    const hb = fnv(logB.join('\n'));
    if (ha !== hb) {
      const i = logA.findIndex((x, k) => x !== logB[k]);
      throw new Error(`第 ${s} 步调用序列不同（第 ${i} 次调用）：\nA ${logA[i]}\nB ${logB[i]}`);
    }
    for (const bey of [A.A, A.B]) {
      if (bey.dashing) cover.dash++;
      if (bey.breakout > 0 && bey.grounded) cover.breakoutDrive++;
      if (bey.spec.bit.gearGrip < T.driveMinGrip && bey.intent.edgeW > 0 && bey.breakout <= 0) cover.edgeOnly++;
      const sat = (bey.spin - T.minStableSpin) / (bey.launchSpin * 0.3);
      if (sat >= 1) cover.pdSat++;
      else if (sat > 0) cover.pdTail++;
      else cover.pdOff++;
      if (bey.tilt > 0.5) cover.scrape++;
    }
  }
  // 结束时完整状态逐位相同
  const st = (x: ReturnType<typeof setup>) =>
    JSON.stringify([x.A, x.B].map((b) => [b.body.translation(), b.body.linvel(), b.body.angvel(), b.body.rotation(), b.spin, b.precession, b.ledger, b.knockResyncs, b.intent.state]));
  expect(st(A)).toBe(st(B));
  A.pw.dispose();
  B.pw.dispose();
  return cover;
}

const sig = (k: string) => SIGNATURE_LIST.find((s) => s.key === k)!.loadout;
/** 签名矩阵里同一对阵的第 0 个场景（发射指令），换一个种子与时长 */
const scn = (p: string, r: string, seed: number, seconds = 40): Scn => {
  const base = matrixScenarios(20000, 20).find((x) => x.name === `${p}-${r}#0`)!;
  return { ...base, name: `c0:${p}:${r}:${seed}`, seed, maxSeconds: seconds };
};

describe('C0 执行顺序与中间状态读取：新旧路径并排推进，刚体调用序列逐位相同', () => {
  it('默认开关：签名对局完整回合（攻 vs 耐、防 vs 衡、镜像），含 PD 饱和 / 尾段 / 失稳与刮地', async () => {
    const R = await rapier();
    const total: Cover = { dash: 0, breakoutDrive: 0, edgeOnly: 0, pdSat: 0, pdTail: 0, pdOff: 0, scrape: 0 };
    for (const [p, r, seed] of [
      ['lieren', 'ziyao', 20001],
      ['pandun', 'senheng', 20002],
      ['ziyao', 'ziyao', 20003],
    ] as const) {
      const c = lockstep(R, scn(p, r, seed, 60), Math.round(60 / PHYSICS_DT));
      for (const k of Object.keys(total) as (keyof Cover)[]) total[k] += c[k];
    }
    expect(total.pdSat).toBeGreaterThan(0);
    expect(total.pdTail).toBeGreaterThan(0);
  }, 300000);

  it('强制分支：脱困方向（breakout）、墙边借用咬合（针尖贴外圈）、轨道冲刺（平齿在轨道上）', async () => {
    const R = await rapier();
    // 脱困：两边同一步把玩家的脱困计时设为 0.7 s
    const c1 = lockstep(R, scn('lieren', 'pandun', 20011), 600, (s, x) => {
      if (s === 120 || s === 360) x.A.breakout = 0.7;
    });
    expect(c1.breakoutDrive).toBeGreaterThan(0);
    // 墙边：磐盾（针尖）在发射过渡结束后（第 300 / 500 步）被放到外圈、带朝外的速度（意图的墙边保护在发射过渡期不计算）
    const c2 = lockstep(R, scn('pandun', 'ziyao', 20012), 700, (s, x) => {
      if (s === 300 || s === 500) {
        const r = 4.1;
        x.A.body.setTranslation({ x: r, y: floorHeight(r) + 0.1, z: 0 }, true);
        x.A.body.setLinvel({ x: 1.5, y: 0, z: 2.5 }, true);
      }
    });
    expect(c2.edgeOnly).toBeGreaterThan(0);
    // 轨道：森衡（平齿，有齿轮）在第 10 步被放到轨道区、沿切向运动
    const c3 = lockstep(R, scn('senheng', 'pandun', 20013), 400, (s, x) => {
      if (s === 10) {
        const r = 4.9;
        x.A.body.setTranslation({ x: r, y: floorHeight(Math.min(r, 5.4)) + 0.1, z: 0 }, true);
        x.A.body.setLinvel({ x: 0, y: 0, z: 4 }, true);
      }
    });
    expect(c3.dash).toBeGreaterThan(0);
  }, 300000);

  it('M4 实验开关下同样逐位相同：tiltDrive、去掉显式牵引 / PD、刮地关闭、陀螺项', async () => {
    const R = await rapier();
    withGyro({ enabled: 1, pd: 0, tiltDrive: 1 }, () => lockstep(R, scn('lieren', 'ziyao', 20021), 900));
    withGyro({ enabled: 1, pd: 0, tiltDrive: 1, explicitDrive: 0 }, () => lockstep(R, scn('senheng', 'pandun', 20022), 900));
    const off = withGyro({ scrape: 0 }, () => lockstep(R, scn('ziyao', 'pandun', 20023, 60), Math.round(60 / PHYSICS_DT)));
    const on = lockstep(R, scn('ziyao', 'pandun', 20023, 60), Math.round(60 / PHYSICS_DT));
    expect(on.scrape + off.scrape).toBeGreaterThan(0);
  }, 300000);
});

// ───────────────────────── C1 只读探针 ─────────────────────────

/**
 * 记录型探针：把探针报告的每一次冲量按刚体实际调用的格式写成期望记录，并读取全部字段（模拟诊断脚本的读取）。
 * A 每一步结束后核对：期望记录全部出现在 A 的刚体调用记录里（参数逐位相同）。
 */
function checkingProbe(seen: Record<string, number>) {
  const want: string[] = [];
  let sink = 0;
  return {
    make: (A: ReturnType<typeof setup>): ExecutorProbe => {
      const tag = (h: ExecutorHost) => (h === A.A ? 'p' : h === A.B ? 'r' : '?');
      const imp = (h: ExecutorHost, x: number, z: number) => want.push(`${tag(h)}.applyImpulse(${JSON.stringify([{ x, y: 0, z }, true])})=null`);
      return {
        rail(h, dx, dz, accel, m, dt, vx, vz) {
          seen.rail++;
          sink += vx + vz;
          imp(h, dx * accel * m * dt, dz * accel * m * dt);
        },
        traction(h, t) {
          seen.traction++;
          if (t.eligible) seen.eligible++;
          sink += t.mag + t.ratio + t.vx + t.vz + t.along + t.cap + t.driveGrip + t.driveScale + t.steering + h.load.N;
          if (t.applied) {
            seen.applied++;
            imp(h, t.dx * t.j, t.dz * t.j);
          }
        },
        rolling(h, vx, vz, sp, dv, m) {
          seen.rolling++;
          imp(h, (-vx / sp) * dv * m, (-vz / sp) * dv * m);
        },
        posture(h, f, s, lean, px0, py0, pz0) {
          seen.posture++;
          if (s > 0) seen.pd++;
          sink += f.px + f.py + f.pz + px0 + py0 + pz0 + (Number.isFinite(lean) ? lean : 0) + h.tilt;
        },
      };
    },
    afterA: (log: string[]) => {
      const have = new Set(log);
      for (const w of want) if (!have.has(w)) throw new Error(`探针报告的冲量不在刚体调用记录里：${w}`);
      seen.checked += want.length;
      want.length = 0;
      if (!Number.isFinite(sink)) sink = 0;
    },
  };
}

describe('C1 只读探针（零行为变化）', () => {
  it('探针开启的执行层与旧路径并排推进：刚体调用序列逐位相同；探针报告的每个冲量与实际 applyImpulse 参数逐位相同', async () => {
    const R = await rapier();
    const seen: Record<string, number> = { rail: 0, traction: 0, eligible: 0, applied: 0, rolling: 0, posture: 0, pd: 0, checked: 0 };
    for (const [p, r, seed] of [
      ['lieren', 'ziyao', 20101],
      ['ziyao', 'ziyao', 20103],
    ] as const) lockstep(R, scn(p, r, seed, 40), Math.round(40 / PHYSICS_DT), undefined, checkingProbe(seen));
    // 轨道冲刺与墙边借用（同 C0 强制分支的摆放）
    lockstep(R, scn('senheng', 'pandun', 20113), 400, (s, x) => {
      if (s === 10) {
        const r = 4.9;
        x.A.body.setTranslation({ x: r, y: floorHeight(Math.min(r, 5.4)) + 0.1, z: 0 }, true);
        x.A.body.setLinvel({ x: 0, y: 0, z: 4 }, true);
      }
    }, checkingProbe(seen));
    lockstep(R, scn('pandun', 'ziyao', 20112), 700, (s, x) => {
      if (s === 300 || s === 500) {
        const r = 4.1;
        x.A.body.setTranslation({ x: r, y: floorHeight(r) + 0.1, z: 0 }, true);
        x.A.body.setLinvel({ x: 1.5, y: 0, z: 2.5 }, true);
      }
    }, checkingProbe(seen));
    expect(EXECUTOR_PROBE.on).toBeNull();
    for (const k of ['rail', 'eligible', 'applied', 'rolling', 'pd', 'checked']) expect(seen[k], k).toBeGreaterThan(0);
    // 每台每步各调用一次牵引与姿态探针
    expect(seen.traction).toBe(seen.posture);
  }, 300000);

  it(`探针开启时与 golden 逐场一致（${process.env.REPRO_FULL ? '全部 180 场' : '每组第一场'}）`, async () => {
    const R = await rapier();
    const all = scenariosV2();
    const list = process.env.REPRO_FULL ? all : all.filter((s, i) => all.findIndex((x) => x.group === s.group) === i);
    const seen: Record<string, number> = { rail: 0, traction: 0, eligible: 0, applied: 0, rolling: 0, posture: 0, pd: 0, checked: 0 };
    let sink = 0;
    const probe: ExecutorProbe = {
      rail: (_h, dx, dz, accel, m, dt, vx, vz) => void (seen.rail++, (sink += dx + dz + accel + m + dt + vx + vz)),
      traction: (h, t) => void (seen.traction++, (sink += t.j + t.along + t.cap + h.load.N)),
      rolling: (_h, vx, vz, sp, dv, m) => void (seen.rolling++, (sink += vx + vz + sp + dv + m)),
      posture: (_h, f, s, _lean, px0, py0, pz0) => void (seen.posture++, (sink += f.px + s + px0 + py0 + pz0)),
    };
    EXECUTOR_PROBE.on = probe;
    let runs: TraceSummary[];
    try {
      runs = list.map((sc) => summarize(recordRun(R, sc, { keyframes: false })));
    } finally {
      EXECUTOR_PROBE.on = null;
    }
    const want = G.runs.filter((g) => list.some((s) => s.name === g.name));
    const rep = compareTraces(runs.map(behavior), want.map(behavior));
    expect(rep.missing).toEqual([]);
    expect(rep.diffs, JSON.stringify(rep.diffs.slice(0, 3), null, 1)).toEqual([]);
    expect(rep.identical).toBe(list.length);
    expect(seen.traction).toBeGreaterThan(0);
    expect(Number.isNaN(sink)).toBe(false);
  }, 600000);
});

// ───────────────────────── 阶段函数的分支语义（假刚体） ─────────────────────────

interface FakeBody {
  v: { x: number; y: number; z: number };
  p: { x: number; y: number; z: number };
  m: number;
  impulses: { x: number; y: number; z: number }[];
}
function fakeHost(all: Omit<Partial<ExecutorHost>, 'intent'> & { bit?: Partial<ExecutorHost['spec']['bit']>; pos?: { x: number; z: number }; v?: { x: number; z: number }; intent?: Record<string, unknown> }) {
  const { bit, pos, v, intent, ...over } = all;
  const ov = { bit, pos, v, intent };
  const fb: FakeBody = { v: { x: ov.v?.x ?? 0, y: 0, z: ov.v?.z ?? 0 }, p: { x: ov.pos?.x ?? 0, y: 0, z: ov.pos?.z ?? 0 }, m: 4, impulses: [] };
  const body = {
    linvel: () => ({ ...fb.v }),
    translation: () => ({ ...fb.p }),
    mass: () => fb.m,
    applyImpulse: (j: { x: number; y: number; z: number }) => {
      fb.impulses.push({ ...j });
      fb.v.x += j.x / fb.m;
      fb.v.z += j.z / fb.m;
    },
  };
  const spec = assembleBey(sig('lieren'));
  const h = {
    body,
    spec: { ...spec, bit: { ...spec.bit, ...(ov.bit ?? {}) } },
    launchSpin: 150,
    spinSign: 1,
    intent: { edgeW: 0, heading: 0, authority: 0, state: 'roam', ...(ov.intent ?? {}) },
    opponent: null,
    breakout: 0,
    bursted: false,
    grounded: true,
    tilt: 0,
    gyroFactor: 1,
    launchHeading: 0,
    pw: { g: 20 },
    precession: 0,
    dashing: false,
    knocked: false,
    knockResyncs: 0,
    ...over,
  } as unknown as ExecutorHost;
  return { h, fb };
}
function frame(mag: number, pos = { x: 0, y: 0, z: 0 }, up = { x: 0, y: 1, z: 0 }): ExecFrame {
  const f = newExecFrame({ ...GYRO_EXPERIMENT });
  f.dt = PHYSICS_DT;
  f.mag = mag;
  f.pos = pos;
  f.r = Math.hypot(pos.x, pos.z);
  f.up = up;
  return f;
}

describe('C0 阶段函数分支语义（与旧代码同一公式）', () => {
  const T = BEY_TUNING;

  it('牵引门限：咬合度 < driveMinGrip 没有牵引、不扣转速；≥ 门限按 driveAccel × grip × 转速比例施加', () => {
    const below = fakeHost({ bit: { gearGrip: T.driveMinGrip - 0.01 } });
    const f1 = frame(150);
    stepTraction(below.h, f1, T);
    expect(below.fb.impulses.length).toBe(0);
    expect(f1.decay).toBe(0);
    const at = fakeHost({ bit: { gearGrip: 0.5 } });
    const f2 = frame(150);
    stepTraction(at.h, f2, T);
    expect(at.fb.impulses.length).toBe(1);
    const j = at.fb.impulses[0];
    expect(Math.hypot(j.x, j.z)).toBeCloseTo(T.driveAccel * 0.5 * 1 * 4 * PHYSICS_DT, 12);
    expect(f2.lDrive).toBeCloseTo(T.driveSpinCost * 0.5, 12);
    // 转速太低（< 2 × minStableSpin）也没有牵引
    const low = fakeHost({ bit: { gearGrip: 0.5 } });
    stepTraction(low.h, frame(T.minStableSpin * 2 - 0.1), T);
    expect(low.fb.impulses.length).toBe(0);
  });

  it('edgeOnly：没有牵引的针尖在外圈借用 edgeGrip，只有牵引方向与墙边修正方向夹角 < 90° 时才施加', () => {
    // 进动相位 0、正转：牵引方向 (−sin0, cos0) = (0, 1)
    const helps = fakeHost({ bit: { gearGrip: 0.1 }, intent: { edgeW: 0.5, heading: Math.PI / 2 } });
    stepTraction(helps.h, frame(150), T);
    expect(helps.fb.impulses.length).toBe(1);
    expect(Math.hypot(helps.fb.impulses[0].x, helps.fb.impulses[0].z)).toBeCloseTo(T.driveAccel * T.edgeGrip * 4 * PHYSICS_DT, 12);
    const against = fakeHost({ bit: { gearGrip: 0.1 }, intent: { edgeW: 0.5, heading: -Math.PI / 2 } });
    stepTraction(against.h, frame(150), T);
    expect(against.fb.impulses.length).toBe(0);
  });

  it('脱困方向：背离对手并按旋向偏开 runupAngle；超过 backoffEdge 时去掉朝外分量', () => {
    const opp = { body: { translation: () => ({ x: 1, y: 0, z: 0 }) } } as unknown as ExecutorHost;
    const near = fakeHost({ bit: { gearGrip: 0.5 }, breakout: 0.5, opponent: opp });
    stepTraction(near.h, frame(150), T);
    const j = near.fb.impulses[0];
    const ang = Math.atan2(j.z, j.x);
    // 背离 = π，按正转偏开 runupAngle
    const want = Math.PI + T.runupAngle;
    expect(Math.abs(Math.atan2(Math.sin(ang - want), Math.cos(ang - want)))).toBeLessThan(1e-9);
    expect(near.h.precession).toBe(0);
    // 外圈：对手在内侧，背离方向朝外 → 朝外分量被削掉
    const pos = { x: 3.5, y: 0, z: 0 };
    const opp2 = { body: { translation: () => ({ x: 2.5, y: 0, z: 0 }) } } as unknown as ExecutorHost;
    const far = fakeHost({ bit: { gearGrip: 0.5 }, breakout: 0.5, opponent: opp2, pos: { x: 3.5, z: 0 } });
    stepTraction(far.h, frame(150, pos), T);
    const j2 = far.fb.impulses[0];
    const outward = j2.x / Math.hypot(j2.x, j2.z);
    expect(outward).toBeLessThan(Math.cos(T.runupAngle) + 1e-9);
  });

  it('tiltDrive：方向垂直于实际倾斜方向（随旋向），大小按 sin θ_rel / sin(drift) 缩放（上限 1）', () => {
    const tilt = 0.05;
    const up = { x: Math.sin(tilt), y: Math.cos(tilt), z: 0 };
    const g = { ...GYRO_EXPERIMENT, tiltDrive: 1 };
    const t = fakeHost({ bit: { gearGrip: 0.5, drift: 0.2 } });
    const f = frame(150, { x: 0, y: 0, z: 0 }, up);
    f.G = g;
    stepTraction(t.h, f, T);
    const j = t.fb.impulses[0];
    // 倾斜朝 +x，正转 → 牵引朝 +z
    expect(j.x).toBeCloseTo(0, 12);
    expect(j.z).toBeGreaterThan(0);
    expect(j.z).toBeCloseTo(T.driveAccel * 0.5 * 1 * 4 * PHYSICS_DT * Math.min(1, Math.sin(tilt) / Math.sin(0.2)), 12);
    expect(f.steering).toBe(0);
  });

  it('PD 饱和与尾段：s = clamp((ω − minStableSpin) / (0.3 ω₀)) × gyroFactor；s = 0 时不改横向角速度；pd = 0 时不修正', () => {
    // 去掉合成进动（precessBase / precessSpin = 0），让目标方向与转速无关；ω₀ = 30 时目标倾角在 ω ≥ 15 饱和，
    // 于是 PD 修正量只随 s 变化：饱和区（ω ≥ 7 + 9 = 16）相同，尾段 = s × 饱和值，ω ≤ 7 时为 0
    const TT = { ...T, precessBase: 0, precessSpin: 0 };
    const run = (mag: number, G = GYRO_EXPERIMENT) => {
      const x = fakeHost({ tilt: 0, gyroFactor: 1, launchSpin: 30, precession: 0.7 });
      const f = frame(mag);
      f.G = { ...G };
      stepPosture(x.h, f, TT);
      return f;
    };
    const sat1 = run(20);
    const sat2 = run(28);
    expect(sat1.px).not.toBe(0);
    expect(sat2.px).toBe(sat1.px);
    expect(sat2.pz).toBe(sat1.pz);
    const tail = run(15.5);
    const s = (15.5 - TT.minStableSpin) / (30 * 0.3);
    expect(tail.px / sat1.px).toBeCloseTo(s, 12);
    expect(tail.pz / sat1.pz).toBeCloseTo(s, 12);
    const off = run(TT.minStableSpin - 1);
    expect(off.px).toBe(0);
    expect(off.pz).toBe(0);
    const pdOff = run(20, { ...GYRO_EXPERIMENT, pd: 0 });
    expect(pdOff.px).toBe(0);
    expect(pdOff.pz).toBe(0);
  });

  it('刮地开关：倾角 > 0.5 rad 时 scrape = 1 计入刮地掉速，scrape = 0 不计（BeyPhysics 级）', async () => {
    const R = await rapier();
    const one = (scrape: number) =>
      withGyro({ scrape }, () => {
        const pw = new PhysicsWorld(R);
        createArenaPhysics(pw);
        const bey = new BeyPhysics(pw, assembleBey(sig('ziyao')), { position: { x: 0, y: floorHeight(0) + 0.3, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, spin: 100, tilt: 0.8, tiltAxis: { x: 1, y: 0, z: 0 }, seed: 1 });
        bey.preStep(PHYSICS_DT);
        const v = bey.ledger.scrape;
        pw.dispose();
        return v;
      });
    expect(one(1)).toBeGreaterThan(0);
    expect(one(0)).toBe(0);
  });
});

// ───────────────────────── 接地法向力 N：来源、读取、滞后 ─────────────────────────

describe('C0 接地法向力 N（只读）', () => {
  it('没有接触观测或不在对局里：无效', () => {
    const out = readTipLoad(null, 'player', PHYSICS_DT, newLoadSample());
    expect(out.valid).toBe(false);
    expect(out.N).toBe(0);
  });

  it('来源与一拍滞后：preStep 读到的是上一子步 observe 后的轴心-地面法向冲量 / dt（1 与 2 子步）', async () => {
    const R = await rapier();
    for (const k of [1, 2]) {
      const saved = { ...PHYSICS_EXPERIMENT };
      Object.assign(PHYSICS_EXPERIMENT, { substeps: k });
      try {
        const sc = scn('ziyao', 'pandun', 20031, 10);
        const x = withDeterminism(sc.seed, () => setup(R, sc, { observeContacts: true })).value;
        const cs = x.pw.contacts!;
        let prev: { imp: number; step: number } | null = null;
        let checked = 0;
        let firstSeen = false;
        const Ns: number[] = [];
        const before = x.pw.beforeStep!;
        x.pw.beforeStep = (dt) => {
          before(dt);
          const L = x.A.load;
          if (!firstSeen) {
            firstSeen = true;
            expect(L.valid).toBe(false);
            expect(L.step).toBe(-1);
          } else {
            expect(L.valid).toBe(true);
            expect(L.step).toBe(prev!.step);
            expect(L.impulse).toBe(prev!.imp);
            expect(L.N).toBe(prev!.imp / x.pw.stepDt);
            checked++;
            if (x.A.grounded && L.N > 0) Ns.push(L.N);
          }
        };
        const after = x.pw.afterStep!;
        x.pw.afterStep = (dt) => {
          const p = cs.colliderPair('player:bit', 'arena:floor');
          prev = { imp: p && p.seenStep === cs.step ? p.normalImpulse : 0, step: cs.step };
          after(dt);
        };
        for (let s = 0; s < 600 && !x.b.result; s++) x.pw.step();
        expect(checked).toBeGreaterThan(500 * k);
        // 量级核对：接地时 N 的中位数与 m·g 同量级（碗面法线方向的支撑力）
        Ns.sort((a, b) => a - b);
        const med = Ns[Math.floor(Ns.length / 2)];
        const mg = x.A.massProps.mass * x.pw.g;
        expect(med / mg).toBeGreaterThan(0.6);
        expect(med / mg).toBeLessThan(1.4);
        x.pw.dispose();
      } finally {
        Object.assign(PHYSICS_EXPERIMENT, saved);
      }
    }
  }, 120000);

  it('读取 N 不改变物理：单台（没有主体名）与对局里 load 都只读', () => {
    // 行为不变由 golden（执行层默认路径，REPRO_FULL 180 场）与上面的并排推进测试共同保证；这里确认单台时一直无效
    const out = newLoadSample();
    readTipLoad(null, null, PHYSICS_DT, out);
    expect(out).toEqual({ valid: false, impulse: 0, N: 0, step: -1, status: 'none' });
  });
});

// ───────────────────────── C2-P 姿态刚度预算（实验开关，默认关闭） ─────────────────────────

/**
 * M4-C · C2-P（docs/engineering/m4c-c2-preregistration.md §3.2、§10，冻结于 1aab164）的实现验收：
 *  1. 开关默认关闭，独立于 BEY_TUNING / 参数指纹 / EXECUTOR_TUNING；
 *  2. 关闭时（kRef 任意）与旧路径并排推进调用序列逐位相同、与 golden 逐场一致；
 *  3. 打开且 kRef = ∞（λ ≡ 1）时与 golden 逐场一致——证明打开后唯一的变化是 λ；
 *  4. λ 的定义：|α_S| = 0 → λ = 1、α_S′ = 0；B = 0 且 |α_S| > 0 → λ = 0；一般情况 λ = min(1, B / (I_t·|α_S|))，截断后刚度项的大小 = α_S,max；
 *     阻尼项、合成进动相位与关闭时逐位相同；不产生 NaN / Inf；探针报告的 α_S、λ 与实际修正量一致。
 */
function withBudget<T>(b: Partial<typeof POSTURE_BUDGET>, fn: () => T): T {
  const old = { ...POSTURE_BUDGET };
  Object.assign(POSTURE_BUDGET, b);
  try {
    return fn();
  } finally {
    Object.assign(POSTURE_BUDGET, old);
  }
}

describe('C2-P 姿态刚度预算：开关与回滚', () => {
  it('默认关闭；不进 BEY_TUNING、参数快照与 EXECUTOR_TUNING', async () => {
    expect(POSTURE_BUDGET).toEqual({ on: 0, kRef: 0 });
    expect(Object.keys(EXECUTOR_TUNING)).toEqual([]);
    expect(Object.keys(BEY_TUNING)).not.toContain('kRef');
    const R = await rapier();
    const snap = JSON.stringify(configSnapshot(R));
    expect(snap.includes('kRef')).toBe(false);
    expect(snap.includes('POSTURE_BUDGET')).toBe(false);
  });

  it('关闭（on = 0，kRef = 0.2）：执行层与旧路径并排推进，刚体调用序列逐位相同（含只读探针）', async () => {
    const R = await rapier();
    const seen: Record<string, number> = { rail: 0, traction: 0, eligible: 0, applied: 0, rolling: 0, posture: 0, pd: 0, checked: 0 };
    withBudget({ on: 0, kRef: 0.2 }, () => {
      for (const [p, r, seed] of [
        ['lieren', 'ziyao', 20201],
        ['senheng', 'senheng', 20202],
      ] as const) lockstep(R, scn(p, r, seed, 40), Math.round(40 / PHYSICS_DT), undefined, checkingProbe(seen));
    });
    expect(seen.pd).toBeGreaterThan(0);
  }, 300000);

  for (const [label, b] of [
    ['关闭（on = 0，kRef = 0.2）', { on: 0, kRef: 0.2 }],
    ['打开且 kRef = ∞（λ ≡ 1）', { on: 1, kRef: Infinity }],
  ] as const)
    it(`${label}：与 golden 逐场一致（${process.env.REPRO_FULL ? '全部 180 场' : '每组第一场'}）`, async () => {
      const R = await rapier();
      const all = scenariosV2();
      const list = process.env.REPRO_FULL ? all : all.filter((s, i) => all.findIndex((x) => x.group === s.group) === i);
      let lamMin = Infinity;
      let pd = 0;
      const probe: ExecutorProbe = {
        rail: () => undefined,
        traction: () => undefined,
        rolling: () => undefined,
        posture: (_h, _f, s, _lean, _px0, _py0, _pz0, _sx, _sz, lam) => {
          if (s > 0) pd++;
          lamMin = Math.min(lamMin, lam);
        },
      };
      const runs = withBudget(b, () => {
        EXECUTOR_PROBE.on = probe;
        try {
          return list.map((sc) => summarize(recordRun(R, sc, { keyframes: false })));
        } finally {
          EXECUTOR_PROBE.on = null;
        }
      });
      const want = G.runs.filter((g) => list.some((s) => s.name === g.name));
      const rep = compareTraces(runs.map(behavior), want.map(behavior));
      expect(rep.missing).toEqual([]);
      expect(rep.diffs, JSON.stringify(rep.diffs.slice(0, 3), null, 1)).toEqual([]);
      expect(rep.identical).toBe(list.length);
      expect(pd).toBeGreaterThan(0);
      expect(lamMin).toBe(1);
    }, 900000);
});

describe('C2-P 姿态刚度预算：λ 的定义与边界（假刚体）', () => {
  const T = BEY_TUNING;
  const It = 0.3;
  /** 一次姿态步：返回 PD 后的 p、进动相位与探针记录 */
  const post = (b: Partial<typeof POSTURE_BUDGET>, o: { mag?: number; up?: { x: number; y: number; z: number }; drift?: number; p?: [number, number, number]; tilt?: number } = {}) =>
    withBudget(b, () => {
      const x = fakeHost({ tilt: o.tilt ?? 0, gyroFactor: 1, launchSpin: 130, precession: 0.7, bit: { drift: o.drift ?? 0.2 }, massProps: { mass: 4.4, comY: 0.42, Ia: 0.46, It } });
      const f = frame(o.mag ?? 100, { x: 0, y: 0, z: 0 }, o.up ?? { x: 0, y: 1, z: 0 });
      [f.px, f.py, f.pz] = o.p ?? [0.4, -0.1, 0.25];
      let rec: { s: number; sx: number; sz: number; lam: number; px0: number; py0: number; pz0: number } | null = null;
      EXECUTOR_PROBE.on = {
        rail: () => undefined,
        traction: () => undefined,
        rolling: () => undefined,
        posture: (_h, _f, s, _lean, px0, py0, pz0, sx, sz, lam) => void (rec = { s, sx, sz, lam, px0, py0, pz0 }),
      };
      try {
        stepPosture(x.h, f, T);
      } finally {
        EXECUTOR_PROBE.on = null;
      }
      return { f, precession: x.h.precession, rec: rec!, Ia: x.h.spec.spinInertia };
    });
  const tilted = { x: Math.sin(0.3) * Math.cos(2), y: Math.cos(0.3), z: Math.sin(0.3) * Math.sin(2) };

  it('|α_S| = 0（转轴恰在目标上）：λ = 1、刚度修正为 0、只有阻尼；不产生 NaN', () => {
    for (const kRef of [0, 0.2, Infinity]) {
      const r = post({ on: 1, kRef }, { drift: 0, up: { x: 0, y: 1, z: 0 } });
      expect(r.rec.sx).toBe(0);
      expect(r.rec.sz).toBe(0);
      expect(r.rec.lam).toBe(1);
      const off = post({ on: 0 }, { drift: 0, up: { x: 0, y: 1, z: 0 } });
      expect([r.f.px, r.f.py, r.f.pz]).toEqual([off.f.px, off.f.py, off.f.pz]);
      for (const v of [r.f.px, r.f.py, r.f.pz]) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('B = 0 且 |α_S| > 0（kRef = 0）：λ = 0，横向角速度只受阻尼；不产生 NaN', () => {
    const r = post({ on: 1, kRef: 0 }, { up: tilted, tilt: 0.3 });
    expect(Math.hypot(r.rec.sx, r.rec.sz)).toBeGreaterThan(1);
    expect(r.rec.lam).toBe(0);
    const s = r.rec.s;
    const dt = PHYSICS_DT;
    expect(r.f.px).toBe(r.rec.px0 + (0 * r.rec.sx - T.uprightDamping * s * r.rec.px0) * dt);
    expect(r.f.pz).toBe(r.rec.pz0 + (0 * r.rec.sz - T.uprightDamping * s * r.rec.pz0) * dt);
    expect(Number.isFinite(r.f.px) && Number.isFinite(r.f.pz)).toBe(true);
  });

  it('一般情况：λ = min(1, B / (I_t·|α_S|))，截断后刚度项大小 = α_S,max = kRef·I_a^game·ω / I_t；阻尼项、py 与进动相位与关闭时逐位相同', () => {
    const mag = 40;
    const off = post({ on: 0 }, { up: tilted, tilt: 0.3, mag });
    for (const kRef of [0.05, 0.2, 0.6, 1.2, 1e6]) {
      const r = post({ on: 1, kRef }, { up: tilted, tilt: 0.3, mag });
      const aS = Math.hypot(r.rec.sx, r.rec.sz);
      const B = kRef * r.Ia * mag;
      const lam = Math.min(1, B / (It * aS));
      expect(r.rec.lam).toBeCloseTo(lam, 14);
      // 探针报告的 α_S 与关闭时的刚度项相同（截断前）
      expect(r.rec.sx).toBe(off.rec.sx);
      expect(r.rec.sz).toBe(off.rec.sz);
      // 实际修正 = λ·α_S + α_D：扣掉阻尼后剩下的刚度项大小
      const dt = PHYSICS_DT;
      const s = r.rec.s;
      const stx = (r.f.px - r.rec.px0) / dt + T.uprightDamping * s * r.rec.px0;
      const stz = (r.f.pz - r.rec.pz0) / dt + T.uprightDamping * s * r.rec.pz0;
      expect(Math.hypot(stx, stz)).toBeCloseTo(Math.min(aS, (kRef * r.Ia * mag) / It), 6);
      if (lam < 1) expect(Math.hypot(stx, stz)).toBeLessThan(aS);
      // 方向不变（只缩放）
      expect(stx * r.rec.sz - stz * r.rec.sx).toBeCloseTo(0, 6);
      expect(r.f.py).toBe(off.f.py);
      expect(r.precession).toBe(off.precession);
    }
    // λ = 1 时（kRef 足够大）与关闭逐位相同
    const big = post({ on: 1, kRef: 1e6 }, { up: tilted, tilt: 0.3, mag });
    expect(big.rec.lam).toBe(1);
    expect([big.f.px, big.f.py, big.f.pz]).toEqual([off.f.px, off.f.py, off.f.pz]);
  });

  it('边界扫描：kRef ∈ {0, 1e-300, 0.2, 1e300, ∞}、ω ∈ {0, 7.5, 40, 200}、多个姿态：结果全部有限，λ ∈ [0, 1]', () => {
    for (const kRef of [0, 1e-300, 0.2, 1e300, Infinity])
      for (const mag of [0, 7.5, 40, 200])
        for (const up of [{ x: 0, y: 1, z: 0 }, tilted, { x: 1, y: 0, z: 0 }, { x: 1e-200, y: 1, z: 0 }]) {
          const r = post({ on: 1, kRef }, { up, mag, tilt: Math.acos(up.y) });
          for (const v of [r.f.px, r.f.py, r.f.pz, r.precession, r.rec.lam]) expect(Number.isFinite(v)).toBe(true);
          expect(r.rec.lam).toBeGreaterThanOrEqual(0);
          expect(r.rec.lam).toBeLessThanOrEqual(1);
        }
  });
});
