/**
 * E1 力分解 + E2 牵引门槛反事实：诊断专用的只读插桩与指标函数（不改 src/）。
 *
 * 插桩只做两件事，都不改变任何数值：
 *  1. 包住每台陀螺 body.applyImpulse / applyImpulseAtPoint，记录游戏代码施加的冲量（原样转发）；
 *  2. 包住 world.step，记录步前 / 步后速度，并在步后读取 Rapier 接触流形（只读查询）。
 * 物理不变由逐步状态 hash 证明（与无插桩运行逐场相同）。
 *
 * 一个物理步（PhysicsWorld.step）内水平速度变化的来源，按发生顺序：
 *  - BattleSystem.preStep → BeyPhysics.preStep：齿轮冲刺 dash、轴心牵引 traction、滚动阻力 roll（游戏代码 applyImpulse，直接测量）
 *  - world.step：重力（竖直）、Rapier 接触（法向 + 摩擦）、线性阻尼
 *  - BattleSystem.postStep → resolveSmash：撞击冲量 smash（applyImpulseAtPoint，直接测量）
 *
 * Rapier 0.19.3（rapier 0.30.1）的事实，决定了哪些量能读到：
 *  - 摩擦冲量读不到：默认摩擦模型 FrictionModel::Simplified 的 writeback_impulses 只写法向总冲量与预热值，
 *    不写 tangent_impulse，contactTangentImpulseX/Y 恒为 0（本插桩逐步记录其绝对值之和以证明）。
 *  - 法向冲量 contactImpulse = total_impulse() = 累加器 + 末次子步冲量；累加器在每个子步开始时加上
 *    “当前冲量”，第 1 个子步加的是上一步留下的预热冲量，所以 8 个子步报告的是 9 份子步冲量。
 *    实际施加 ≈ 报告值 × 8/9（稳态近似，用竖直方向动量平衡验证）。
 *  - 线性阻尼在求解后施加：v_out = v_solver / (1 + dt·c)，阻尼贡献 = −v_out·dt·c（由实测速度按源码公式计算）。
 * 摩擦因此只能由“实测 Δv − 已测各项”推断，并用两条独立约束检验：
 *  (a) 摩擦必须位于接触切平面内 → 残差的法向分量是未解释部分；
 *  (b) 摩擦大小不超过库仑锥 μλ → 超出部分是未解释部分。
 */
import { GRAVITY, PHYSICS_DT, type PhysicsWorld } from '../../src/game/physics/PhysicsWorld';
import { BEY_TUNING, type BeyPhysics } from '../../src/game/beys/BeyPhysics';
import type { BattleSystem } from '../../src/game/battle/BattleSystem';
import type { R } from './stallprobe2.shared';

export type V = { x: number; y: number; z: number };
const Z = (): V => ({ x: 0, y: 0, z: 0 });

/** Rapier 0.30.1：报告的法向冲量含一份上一步预热冲量（8 个子步报告 9 份） */
export const NUM_SUBSTEPS = 8;
export const IMPULSE_CORR = NUM_SUBSTEPS / (NUM_SUBSTEPS + 1);
export const LIN_DAMPING = 0.15;

/** 一台陀螺一个物理步的力学账本（冲量，N·s；Δv = 冲量 / m） */
export interface Ledger {
  m: number;
  /** 步开始（preStep 前）、preStep 后（= world.step 前）、world.step 后、步结束（postStep 后）的线速度 */
  v0: V;
  v1: V;
  v2: V;
  v3: V;
  /** world.step 前的角速度（preStep 已写入自稳角速度之后） */
  w1: V;
  /** 游戏代码冲量（直接测量） */
  trac: V;
  roll: V;
  dash: V;
  smash: V;
  /** 无法归类的游戏代码冲量（应恒为 0） */
  unclassified: number;
  /** 牵引本步是否实际施加 */
  tracOn: boolean;
  /** 阻尼（源码公式 × 实测速度） */
  damp: V;
  /** Rapier 法向冲量（报告值 × 8/9）：地面、墙等静态体、对手 */
  nFloor: V;
  nStatic: V;
  nBey: V;
  lamFloor: number;
  lamStatic: number;
  lamBey: number;
  /** Σ μλ（库仑锥上限） */
  cone: number;
  /** 地面接触的 λ 加权法向（单位向量；无地面接触时为 0） */
  floorN: V;
  /** 地面接触点（λ 加权，世界坐标） */
  floorP: V;
  /** contactTangentImpulseX/Y 绝对值之和（证明读不到） */
  tangentRead: number;
  /** 推断摩擦（切平面内、锥内的残差部分） */
  fric: V;
  /** 未解释残差 */
  unexpl: V;
  /** 接触组合：none / floor / mixed（地面 + 墙或对手同时有冲量）/ other（只有墙或对手） */
  kind: 'none' | 'floor' | 'mixed' | 'other';
  /** 接触点（地面）步前滑移速度（切平面内） */
  slip: V;
  /** 滑移速度分解（切平面内）：线速度项、绕轴自转项 ω∥×r、垂直于轴的角速度项（自稳回正 / 摆动）ω⊥×r */
  slipLin: V;
  slipSpin: V;
  slipPerp: V;
  /** 闭合检查：|m(v1−v0) − (trac+roll+dash)|、|m(v3−v2) − smash|（应为浮点误差量级） */
  preErr: number;
  postErr: number;
}

function emptyLedger(): Ledger {
  return { m: 0, v0: Z(), v1: Z(), v2: Z(), v3: Z(), w1: Z(), trac: Z(), roll: Z(), dash: Z(), smash: Z(), unclassified: 0, tracOn: false, damp: Z(), nFloor: Z(), nStatic: Z(), nBey: Z(), lamFloor: 0, lamStatic: 0, lamBey: 0, cone: 0, floorN: Z(), floorP: Z(), tangentRead: 0, fric: Z(), unexpl: Z(), kind: 'none', slip: Z(), slipLin: Z(), slipSpin: Z(), slipPerp: Z(), preErr: 0, postErr: 0 };
}

const cp = (v: V): V => ({ x: v.x, y: v.y, z: v.z });
const add = (a: V, b: V, k = 1) => {
  a.x += b.x * k;
  a.y += b.y * k;
  a.z += b.z * k;
};
const dot = (a: V, b: V) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: V, b: V): V => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });

/** 游戏代码冲量归类：滚动阻力（−v̂ · min(sp, k·g·dt) · m，与 BeyPhysics.preStep 同式）、冲刺（dashing 时第一笔）、牵引（其余） */
export function classifyPreStepImpulses(bey: BeyPhysics, calls: { j: V; v: V }[], dashing: boolean) {
  const T = BEY_TUNING;
  const m = bey.body.mass();
  const out = { trac: Z(), roll: Z(), dash: Z(), unclassified: 0, tracOn: false };
  calls.forEach((c, k) => {
    const sp = Math.hypot(c.v.x, c.v.z);
    const dv = Math.min(sp, (T.rollBase + T.rollFriction * bey.spec.tip.friction) * -GRAVITY * PHYSICS_DT);
    const ex = sp > 1e-3 ? (-c.v.x / sp) * dv * m : NaN;
    const ez = sp > 1e-3 ? (-c.v.z / sp) * dv * m : NaN;
    const tol = 1e-12 * m;
    if (c.j.y === 0 && Math.abs(c.j.x - ex) <= tol && Math.abs(c.j.z - ez) <= tol && k === calls.length - 1) add(out.roll, c.j);
    else if (dashing && k === 0) add(out.dash, c.j);
    else if (!dashing && c.j.y === 0 && k === 0) {
      add(out.trac, c.j);
      out.tracOn = true;
    } else out.unclassified++;
  });
  return out;
}

/**
 * 把账本闭合：r = m·Δv(world.step) − m·g·dt·ŷ − 阻尼 − 全部法向冲量，按接触组合拆成推断摩擦与未解释残差。
 * 纯函数，单测直接调用。
 */
export function closeLedger(L: Ledger) {
  const m = L.m;
  L.preErr = Math.hypot(m * (L.v1.x - L.v0.x) - L.trac.x - L.roll.x - L.dash.x, m * (L.v1.y - L.v0.y), m * (L.v1.z - L.v0.z) - L.trac.z - L.roll.z - L.dash.z);
  L.postErr = Math.hypot(m * (L.v3.x - L.v2.x) - L.smash.x, m * (L.v3.y - L.v2.y) - L.smash.y, m * (L.v3.z - L.v2.z) - L.smash.z);
  const r: V = { x: m * (L.v2.x - L.v1.x) - L.damp.x, y: m * (L.v2.y - L.v1.y - GRAVITY * PHYSICS_DT) - L.damp.y, z: m * (L.v2.z - L.v1.z) - L.damp.z };
  add(r, L.nFloor, -1);
  add(r, L.nStatic, -1);
  add(r, L.nBey, -1);
  const floor = L.lamFloor > 0;
  const other = L.lamStatic > 0 || L.lamBey > 0;
  L.kind = floor ? (other ? 'mixed' : 'floor') : other ? 'other' : 'none';
  if (L.kind === 'none') {
    L.fric = Z();
    L.unexpl = r;
    return;
  }
  let t = cp(r);
  const un = Z();
  if (L.kind === 'floor') {
    const n = L.floorN;
    const rn = dot(r, n);
    t = { x: r.x - rn * n.x, y: r.y - rn * n.y, z: r.z - rn * n.z };
    add(un, n, rn);
  }
  const tm = Math.hypot(t.x, t.y, t.z);
  if (tm > L.cone * (1 + 1e-3) && tm > 0) {
    const k = L.cone / tm;
    add(un, t, 1 - k);
    t = { x: t.x * k, y: t.y * k, z: t.z * k };
  }
  L.fric = t;
  L.unexpl = un;
}

export interface Instrument {
  /** 当前步两台的账本（pw.step() 之后读取） */
  led: [Ledger, Ledger];
  /** 是否读取接触流形（E2 只需要冲量归类时可关掉以省时间） */
  contacts: boolean;
}

/** 安装插桩（原样转发所有调用，只记录） */
export function instrument(R: R, pw: PhysicsWorld, b: BattleSystem, beys: [BeyPhysics, BeyPhysics], contacts = true): Instrument {
  const ins: Instrument = { led: [emptyLedger(), emptyLedger()], contacts };
  const calls: { j: V; v: V }[][] = [[], []];
  const phase = { pre: false };
  beys.forEach((x, i) => {
    const body = x.body;
    const ai = body.applyImpulse.bind(body);
    const ap = body.applyImpulseAtPoint.bind(body);
    (body as unknown as { applyImpulse: typeof body.applyImpulse }).applyImpulse = (j, wake) => {
      if (phase.pre) calls[i].push({ j: cp(j as V), v: cp(body.linvel()) });
      else ins.led[i].unclassified++;
      ai(j, wake);
    };
    (body as unknown as { applyImpulseAtPoint: typeof body.applyImpulseAtPoint }).applyImpulseAtPoint = (j, p, wake) => {
      add(ins.led[i].smash, j as V);
      ap(j, p, wake);
    };
    const pre = x.preStep.bind(x);
    x.preStep = (dt: number) => {
      const L = emptyLedger();
      L.m = body.mass();
      L.v0 = cp(body.linvel());
      ins.led[i] = L;
      calls[i].length = 0;
      phase.pre = true;
      try {
        pre(dt);
      } finally {
        phase.pre = false;
      }
      const c = classifyPreStepImpulses(x, calls[i], x.dashing);
      L.trac = c.trac;
      L.roll = c.roll;
      L.dash = c.dash;
      L.unclassified += c.unclassified;
      L.tracOn = c.tracOn;
    };
  });
  const world = pw.world;
  const ws = world.step.bind(world);
  (world as unknown as { step: typeof world.step }).step = (ev, hooks) => {
    beys.forEach((x, i) => {
      ins.led[i].v1 = cp(x.body.linvel());
      ins.led[i].w1 = cp(x.body.angvel());
    });
    ws(ev, hooks);
    beys.forEach((x, i) => {
      const L = ins.led[i];
      L.v2 = cp(x.body.linvel());
      const c = LIN_DAMPING * PHYSICS_DT;
      L.damp = { x: -L.m * L.v2.x * c, y: -L.m * L.v2.y * c, z: -L.m * L.v2.z * c };
      if (ins.contacts) readContacts(R, world, x, beys[1 - i], L);
    });
  };
  const after = pw.afterStep;
  pw.afterStep = (dt) => {
    after?.(dt);
    beys.forEach((x, i) => {
      const L = ins.led[i];
      L.v3 = cp(x.body.linvel());
      if (ins.contacts) closeLedger(L);
    });
  };
  void b;
  return ins;
}

function readContacts(R: R, world: PhysicsWorld['world'], x: BeyPhysics, opp: BeyPhysics, L: Ledger) {
  const com = x.body.worldCom();
  const fp = Z();
  let fw = 0;
  for (const c of x.colliders) {
    world.contactPairsWith(c, (o) => {
      const isBey = opp.ownsCollider(o.handle);
      const isFloor = !isBey && o.shapeType() === R.ShapeType.TriMesh;
      world.contactPair(c, o, (man, flipped) => {
        const nv = man.normal();
        const s = flipped ? 1 : -1;
        const n = { x: s * nv.x, y: s * nv.y, z: s * nv.z };
        let lam = 0;
        for (let k = 0; k < man.numContacts(); k++) {
          lam += man.contactImpulse(k);
          L.tangentRead += Math.abs(man.contactTangentImpulseX(k)) + Math.abs(man.contactTangentImpulseY(k));
        }
        lam *= IMPULSE_CORR;
        if (lam <= 0) return;
        const mu = man.numSolverContacts() > 0 ? man.solverContactFriction(0) : 0;
        L.cone += mu * lam;
        if (isBey) {
          add(L.nBey, n, lam);
          L.lamBey += lam;
        } else if (isFloor) {
          add(L.nFloor, n, lam);
          L.lamFloor += lam;
          const ns = man.numSolverContacts();
          for (let k = 0; k < ns; k++) {
            const p = man.solverContactPoint(k);
            add(fp, p, lam / ns);
            fw += lam / ns;
          }
        } else {
          add(L.nStatic, n, lam);
          L.lamStatic += lam;
        }
      });
    });
  }
  if (L.lamFloor > 0) {
    const l = Math.hypot(L.nFloor.x, L.nFloor.y, L.nFloor.z);
    L.floorN = { x: L.nFloor.x / l, y: L.nFloor.y / l, z: L.nFloor.z / l };
  }
  if (fw > 0) {
    L.floorP = { x: fp.x / fw, y: fp.y / fw, z: fp.z / fw };
    const rr = { x: L.floorP.x - com.x, y: L.floorP.y - com.y, z: L.floorP.z - com.z };
    const wc = cross(L.w1, rr);
    const vc = { x: L.v1.x + wc.x, y: L.v1.y + wc.y, z: L.v1.z + wc.z };
    const n = L.floorN;
    const proj = (u: V): V => {
      const d = dot(u, n);
      return { x: u.x - d * n.x, y: u.y - d * n.y, z: u.z - d * n.z };
    };
    L.slip = proj(vc);
    const u = x.up();
    const ws = dot(L.w1, u);
    const wpar = { x: u.x * ws, y: u.y * ws, z: u.z * ws };
    const wperp = { x: L.w1.x - wpar.x, y: L.w1.y - wpar.y, z: L.w1.z - wpar.z };
    L.slipLin = proj(L.v1);
    L.slipSpin = proj(cross(wpar, rr));
    L.slipPerp = proj(cross(wperp, rr));
  }
}

/** 低速步判定（与探针 V2 WATCH(0.4)、Stage B 同口径）：几何接触或冲量响应后 6 步内算接触 */
export class LowSpeed {
  miss = 99;
  step(b: BattleSystem, a: BeyPhysics, c: BeyPhysics): boolean {
    const k = b.contactClass;
    this.miss = k.geometric || k.impulseResponse ? 0 : this.miss + 1;
    const va = a.body.linvel();
    const vc = c.body.linvel();
    return this.miss > 6 && Math.hypot(va.x, va.z) < 0.4 && Math.hypot(vc.x, vc.z) < 0.4 && a.spin > 10 && c.spin > 10;
  }
}

/** 逐步轨迹（E2 窗口指标的输入） */
export interface Track {
  n: number;
  px: Float64Array[];
  pz: Float64Array[];
  speed: Float64Array[];
  spin: Float64Array[];
  geo: Uint8Array;
  low: Uint8Array;
  trac: Uint8Array[];
}

export function newTrack(N: number): Track {
  const f = () => [new Float64Array(N), new Float64Array(N)];
  return { n: 0, px: f(), pz: f(), speed: f(), spin: f(), geo: new Uint8Array(N), low: new Uint8Array(N), trac: [new Uint8Array(N), new Uint8Array(N)] };
}

/** 一台陀螺在 [i0, i1) 步窗口内的运动指标（真实坐标） */
export function windowMetrics(t: Track, i: number, i0: number, i1: number) {
  const j = 1 - i;
  let path = 0;
  let low = 0;
  let slow = 0;
  let trac = 0;
  let cosSum = 0;
  let cosW = 0;
  let mx = 0;
  let mz = 0;
  let maxSpeed = 0;
  for (let s = i0; s < i1; s++) {
    if (s > i0) path += Math.hypot(t.px[i][s] - t.px[i][s - 1], t.pz[i][s] - t.pz[i][s - 1]);
    if (t.low[s]) low++;
    if (t.speed[i][s] < 0.4) slow++;
    if (t.trac[i][s]) trac++;
    mx += t.px[i][s];
    mz += t.pz[i][s];
    maxSpeed = Math.max(maxSpeed, t.speed[i][s]);
    if (s > i0) {
      const dx = t.px[i][s] - t.px[i][s - 1];
      const dz = t.pz[i][s] - t.pz[i][s - 1];
      const ox = t.px[j][s - 1] - t.px[i][s - 1];
      const oz = t.pz[j][s - 1] - t.pz[i][s - 1];
      const dl = Math.hypot(dx, dz);
      const ol = Math.hypot(ox, oz);
      if (dl > 0 && ol > 0) {
        cosSum += (dx * ox + dz * oz) / ol; // 按位移长度加权的 cos
        cosW += dl;
      }
    }
  }
  const n = i1 - i0;
  mx /= n;
  mz /= n;
  let g = 0;
  for (let s = i0; s < i1; s++) g += (t.px[i][s] - mx) ** 2 + (t.pz[i][s] - mz) ** 2;
  const net = Math.hypot(t.px[i][i1 - 1] - t.px[i][i0], t.pz[i][i1 - 1] - t.pz[i][i0]);
  const d0 = Math.hypot(t.px[j][i0] - t.px[i][i0], t.pz[j][i0] - t.pz[i][i0]);
  const d1 = Math.hypot(t.px[j][i1 - 1] - t.px[i][i1 - 1], t.pz[j][i1 - 1] - t.pz[i][i1 - 1]);
  return {
    net,
    path,
    straightness: path > 1e-9 ? net / path : 0,
    /** 低速（双方 < 0.4 且无接触，同 V2 口径）占比 */
    lowShare: low / n,
    /** 自身速度 < 0.4 m/s 占比 */
    slowShare: slow / n,
    tracShare: trac / n,
    /** 位移方向与指向对手方向夹角余弦（按位移长度加权平均） */
    approachCos: cosW > 0 ? cosSum / cosW : 0,
    /** 轨迹回转半径（轨迹点到平均位置的均方根距离） */
    gyration: Math.sqrt(g / n),
    distStart: d0,
    distEnd: d1,
    maxSpeed,
  };
}

export type WindowClass = 'stalled' | 'intermittent' | 'circling' | 'towardOpponent' | 'moving';

/**
 * 窗口分类（每台每窗口，按顺序第一条成立）：
 *  stalled 停滞：自身速度 < 0.4 占比 ≥ 80%
 *  intermittent 短暂移动后再次停滞：自身速度 < 0.4 占比 ≥ 30%
 *  circling 有路径无有效净位移（小半径原地绕圈）：路径 ≥ 2 m 且回转半径 < 0.35 m
 *  towardOpponent 向对手移动：位移方向与对手方向余弦 ≥ 0.3
 *  moving 持续运动（其他）
 */
export function classifyWindow(w: ReturnType<typeof windowMetrics>): WindowClass {
  if (w.slowShare >= 0.8) return 'stalled';
  if (w.slowShare >= 0.3) return 'intermittent';
  if (w.path >= 2 && w.gyration < 0.35) return 'circling';
  if (w.approachCos >= 0.3) return 'towardOpponent';
  return 'moving';
}

/** E2 诊断覆盖：只在 fn 执行期间把 driveMinGrip 设为 v，结束后无条件恢复 */
export function withDriveMinGrip<T>(v: number | null, fn: () => T): T {
  if (v === null) return fn();
  const saved = BEY_TUNING.driveMinGrip;
  BEY_TUNING.driveMinGrip = v;
  try {
    return fn();
  } finally {
    BEY_TUNING.driveMinGrip = saved;
  }
}

/** Stage A 原始牵引门槛（模块加载时读取，不受诊断覆盖影响） */
export const BASE_MIN_GRIP = BEY_TUNING.driveMinGrip;
/** 针尖对针尖：双方 gearGrip 都低于 Stage A 牵引门槛 */
export const isNN = (beys: BeyPhysics[]) => beys.every((x) => x.spec.tip.gearGrip < BASE_MIN_GRIP);
