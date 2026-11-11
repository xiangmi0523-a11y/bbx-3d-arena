import { describe, expect, it } from 'vitest';
import golden from './fixtures/repro-golden.json';
import { scenariosV2, setup, type Scn } from './diag/stallprobe2.shared';
import { matrixScenarios } from './diag/m5b.shared';
import { compareTraces, summarize, type TraceSummary } from './repro/compare';
import { configSnapshot } from './repro/config';
import { rapier, recordRun } from './repro/recorder';
import { withDeterminism } from './repro/determinism';
import { BEY_TUNING, BeyPhysics } from '../src/game/beys/BeyPhysics';
import { EXECUTOR_SWITCH, EXECUTOR_TUNING, newExecFrame, readTipLoad, newLoadSample, stepPosture, stepTraction, type ExecutorHost, type ExecFrame } from '../src/game/beys/motionExecutor';
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
function lockstep(R: R, sc: Scn, frames: number, perturb?: (step: number, b: ReturnType<typeof setup>) => void): Cover {
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
  for (let s = 0; s < frames && !A.b.result && !B.b.result; s++) {
    perturb?.(s, A);
    perturb?.(s, B);
    logA.length = 0;
    logB.length = 0;
    withSwitch(0, () => A.pw.step());
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
