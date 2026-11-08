/**
 * R1c：针尖对针尖低速僵持的受控恢复辅助（独立通道，Stage B 实验）。
 *
 * 只针对一种已确认的情形（探针 V1 / V2）：两台都是轴心本身没有牵引的陀螺（gearGrip < driveMinGrip，即针尖），
 * 高转速、转速相近，在碗底隔 2–8 cm 原地慢漂几十秒，期间轴心牵引从未施加（咬合不够）。
 *
 * 与正常运动逻辑分离：不改 gearGrip、不改全局牵引规则、不改任何共用运动参数、不启用旧的通用 watchStall 脱困。
 * 恢复期间每台的施力方向 = 自然进动给出的牵引方向，向“对手预测拦截点”方向最多偏 maxBias；
 * 偏转后仍背离对手（与拦截方向夹角 ≥ 90°）的步不施力——绝不把两台推开。
 * 大小按原有轴心牵引公式（driveAccel × 借用咬合 edgeGrip × 转速比例），再受加速度 / 速度 / 时长 / 累计 Δv 上限约束，
 * 并按原有牵引的转速消耗规则消耗转速。
 *
 * 状态：idle → dwell（分类条件持续成立计时）→ active（施加辅助）→ cooldown → idle。
 * dwell 中任一条件失效即回到 idle；active 满足任一退出条件即进入 cooldown。
 * 进入条件不要求真实接触（僵持时两台常隔着 2–8 cm）。
 */
import type { BeyPhysics } from '../beys/BeyPhysics';
import { BEY_TUNING } from '../beys/BeyPhysics';
import type { ContactClass } from './contactSampling';

export const R1C_TUNING = {
  /** 1 = 启用；0 = 完全不介入（与 Stage A 物理逐步一致） */
  enabled: 1,
  // ── 分类（依据见 research/stage-b-r1c 报告第 2 节，来自探针 V2 原始数据） ──
  /** 双方水平速度都低于它才算低速（m/s，探针 WATCH(0.4) 口径） */
  slowSpeed: 0.4,
  /** 分类持续成立多久后进入恢复（秒）：V2 中达到 3 s 的针尖对针尖低速段 24/24 都持续 ≥ 54 s；2 s 时有 1 段 2.4 s 自行结束 */
  dwellTime: 3,
  /** dwell 期间每台净位移上限（m）：V2 长僵持段 3 s 净位移最大 0.354 */
  dwellNetMax: 0.4,
  /** 双方转速比例下限：只处理高转速僵持，远离终局 wobble 区（wobbleSpin 0.25）；V2 长僵持进入时最低 0.74 */
  minSpinRatio: 0.4,
  /** 两台转速之比上限（较大 / 较小）：V2 长僵持进入时 0.91–1.28 */
  maxSpinImbalance: 1.5,
  /** 刀刃 XZ 间隙上限（m），超过视为目标状态无效：V2 长僵持候选间隙 P90 0.084、最大 0.22 */
  maxGap: 0.25,
  // ── 辅助上限 ──
  /** 自然牵引方向向拦截方向的最大偏转（弧度） */
  maxBias: Math.PI / 6,
  /** 最大恢复加速度（m/s²）：低于原有牵引公式在借用咬合下的值（30 × 0.3 × 转速比例 ≈ 6–9） */
  maxAccel: 4,
  /** 沿施力方向的最大速度（m/s）：WATCH 门槛的 1.5 倍，远低于正常对战移动速度（V2：WATCH 外针尖 P50 约 1.3） */
  maxSpeed: 0.6,
  /** 单次恢复最长时间（秒）：V1/V2 中 R1a 重新接触用时 P90 约 1.6 s */
  maxTime: 1.5,
  /** 单次恢复累计施加的 Δv 上限（m/s，每台） */
  maxDeltaV: 1.0,
  /** 退出后冷却（秒），冷却期间不计 dwell */
  cooldown: 3,
  /** 恢复中任一台相对启动位置的净位移超过它，视为已恢复移动（m） */
  movedNet: 0.25,
  /** 拦截预测的最长前瞻（秒） */
  maxLead: 0.5,
};

export type R1cState = 'idle' | 'dwell' | 'active' | 'cooldown';
export type R1cExit = 'contact' | 'moved' | 'unclassified' | 'wobble' | 'timeout' | 'budget' | 'invalid';

export interface R1cContext {
  contact: ContactClass;
  contactValid: boolean;
  wobbleFor: number;
  wobbleBreaks: number;
}

/** 每次恢复的记录（诊断与报告用） */
export interface R1cActivation {
  t0: number;
  t1: number;
  exit: R1cExit;
  /** 启动时：刀刃间隙、双方速度、转速、转速比例 */
  gap0: number;
  speed0: number[];
  spin0: number[];
  spinRatio0: number[];
  /** 恢复期间施力的步数、累计 Δv（每台） */
  pushSteps: number[];
  deltaV: number[];
  /** 施力方向与拦截方向夹角（度）的平均与最大；自然方向与拦截方向夹角的平均 */
  biasAngleMean: number;
  biasAngleMax: number;
  naturalAngleMean: number;
  /** 期间最大水平速度、转速损失（含辅助消耗） */
  maxSpeed: number;
  spinLoss: number[];
  assistSpinCost: number[];
}

const ang = (ax: number, az: number, bx: number, bz: number) => Math.atan2(ax * bz - az * bx, ax * bx + az * bz);

export class StallRecovery {
  state: R1cState = 'idle';
  /** 当前状态已持续时间 */
  timer = 0;
  readonly log: R1cActivation[] = [];
  /** 本步每台是否施加了辅助、方向（诊断） */
  readonly push = [
    { on: false, dx: 0, dz: 0, tx: 0, tz: 0 },
    { on: false, dx: 0, dz: 0, tx: 0, tz: 0 },
  ];
  private start = [
    { x: 0, z: 0 },
    { x: 0, z: 0 },
  ];
  private cur: (R1cActivation & { biasSum: number; natSum: number; n: number }) | null = null;
  private wobbleBreaks0 = 0;

  /** 最近一次分类不成立的原因（诊断）；成立时为 null */
  reject: string | null = 'init';

  /** 分类：本步是否处于“针尖对针尖、牵引无效、高转速、转速相近、低速、未接触”的僵持形态（不含持续时间与位移） */
  classify(a: BeyPhysics, b: BeyPhysics, ctx: R1cContext): boolean {
    this.reject = this.why(a, b, ctx);
    return this.reject === null;
  }

  private why(a: BeyPhysics, b: BeyPhysics, ctx: R1cContext): string | null {
    const T = R1C_TUNING;
    const minGrip = BEY_TUNING.driveMinGrip;
    for (const x of [a, b]) if (!(x.spec.tip.gearGrip < minGrip)) return 'tip';
    for (const x of [a, b]) {
      if (!x.grounded || x.dashing || x.breakout > 0 || x.intentState === 'launch') return 'motionState';
      if (x.tractionApplied) return 'traction';
    }
    for (const x of [a, b]) {
      const v = x.body.linvel();
      if (Math.hypot(v.x, v.z) >= T.slowSpeed) return 'speed';
    }
    if (ctx.contactValid && (ctx.contact.geometric || ctx.contact.impulseResponse)) return 'contact';
    if (ctx.wobbleFor > 0) return 'wobble';
    for (const x of [a, b]) if (x.spinRatio < T.minSpinRatio) return 'lowSpin';
    const hi = Math.max(a.spin, b.spin);
    const lo = Math.max(1e-6, Math.min(a.spin, b.spin));
    if (hi / lo > T.maxSpinImbalance) return 'spinImbalance';
    if (this.gap(a, b) > T.maxGap) return 'gap';
    return null;
  }

  private gap(a: BeyPhysics, b: BeyPhysics): number {
    const pa = a.body.translation();
    const pb = b.body.translation();
    return Math.hypot(pa.x - pb.x, pa.z - pb.z) - a.spec.blade.radius - b.spec.blade.radius;
  }

  /** 每个物理步、两台 preStep 之后调用；可能对两台施加辅助冲量 */
  step(dt: number, time: number, a: BeyPhysics, b: BeyPhysics, ctx: R1cContext): void {
    const T = R1C_TUNING;
    this.push[0].on = this.push[1].on = false;
    if (!(T.enabled > 0)) return;
    const beys = [a, b];
    this.timer += dt;
    if (this.state === 'cooldown') {
      if (this.timer >= T.cooldown) this.enter('idle');
      return;
    }
    if (this.state === 'idle' || this.state === 'dwell') {
      if (!this.classify(a, b, ctx)) {
        if (this.state === 'dwell') this.enter('idle');
        return;
      }
      if (this.state === 'idle') {
        this.enter('dwell');
        beys.forEach((x, i) => (this.start[i] = { x: x.body.translation().x, z: x.body.translation().z }));
        return;
      }
      // dwell：持续时间与净位移（真实坐标，相对 dwell 起点）
      const moved = beys.some((x, i) => Math.hypot(x.body.translation().x - this.start[i].x, x.body.translation().z - this.start[i].z) > T.dwellNetMax);
      if (moved) {
        this.enter('dwell');
        beys.forEach((x, i) => (this.start[i] = { x: x.body.translation().x, z: x.body.translation().z }));
        return;
      }
      if (this.timer < T.dwellTime) return;
      this.activate(time, a, b, ctx);
    }
    // active
    const c = this.cur!;
    const exit = this.checkExit(a, b, ctx);
    if (exit) {
      this.finish(time, exit, a, b);
      return;
    }
    this.apply(dt, a, b, c);
  }

  private enter(s: R1cState): void {
    this.state = s;
    this.timer = 0;
  }

  private activate(time: number, a: BeyPhysics, b: BeyPhysics, ctx: R1cContext): void {
    const beys = [a, b];
    this.enter('active');
    this.wobbleBreaks0 = ctx.wobbleBreaks;
    beys.forEach((x, i) => (this.start[i] = { x: x.body.translation().x, z: x.body.translation().z }));
    this.cur = {
      t0: time,
      t1: time,
      exit: 'timeout',
      gap0: this.gap(a, b),
      speed0: beys.map((x) => Math.hypot(x.body.linvel().x, x.body.linvel().z)),
      spin0: beys.map((x) => x.spin),
      spinRatio0: beys.map((x) => x.spinRatio),
      pushSteps: [0, 0],
      deltaV: [0, 0],
      biasAngleMean: 0,
      biasAngleMax: 0,
      naturalAngleMean: 0,
      maxSpeed: 0,
      spinLoss: [0, 0],
      assistSpinCost: [0, 0],
      biasSum: 0,
      natSum: 0,
      n: 0,
    };
  }

  private checkExit(a: BeyPhysics, b: BeyPhysics, ctx: R1cContext): R1cExit | null {
    const T = R1C_TUNING;
    const beys = [a, b];
    for (const x of beys) {
      const p = x.body.translation();
      const v = x.body.linvel();
      if (![p.x, p.z, v.x, v.z, x.spin].every(Number.isFinite)) return 'invalid';
    }
    if (ctx.contactValid && ctx.contact.geometric) return 'contact';
    if (ctx.wobbleFor > 0 || ctx.wobbleBreaks > this.wobbleBreaks0) return 'wobble';
    if (this.timer >= T.maxTime) return 'timeout';
    if (this.cur!.deltaV.every((v) => v >= T.maxDeltaV)) return 'budget';
    if (this.gap(a, b) > T.maxGap * 2) return 'invalid';
    // 分类中与速度无关的部分不再成立（辅助本身会提高速度，所以不看速度）
    const minGrip = BEY_TUNING.driveMinGrip;
    for (const x of beys) {
      if (!(x.spec.tip.gearGrip < minGrip) || !x.grounded || x.dashing || x.breakout > 0 || x.spinRatio < T.minSpinRatio) return 'unclassified';
    }
    if (Math.max(a.spin, b.spin) / Math.max(1e-6, Math.min(a.spin, b.spin)) > T.maxSpinImbalance) return 'unclassified';
    if (beys.some((x, i) => Math.hypot(x.body.translation().x - this.start[i].x, x.body.translation().z - this.start[i].z) > T.movedNet)) return 'moved';
    return null;
  }

  private apply(dt: number, a: BeyPhysics, b: BeyPhysics, c: R1cActivation & { biasSum: number; natSum: number; n: number }): void {
    const T = R1C_TUNING;
    const beys = [a, b];
    beys.forEach((x, i) => {
      const o = beys[1 - i];
      const p = x.body.translation();
      const v = x.body.linvel();
      const op = o.body.translation();
      const ov = o.body.linvel();
      c.maxSpeed = Math.max(c.maxSpeed, Math.hypot(v.x, v.z));
      // 拦截预测：对手按当前速度前移 lead 秒，lead 按距离 / 恢复速度上限估计
      const d0 = Math.hypot(op.x - p.x, op.z - p.z);
      const lead = Math.min(T.maxLead, d0 / T.maxSpeed);
      let tx = op.x + ov.x * lead - p.x;
      let tz = op.z + ov.z * lead - p.z;
      const tl = Math.hypot(tx, tz);
      if (tl < 1e-6 || c.deltaV[i] >= T.maxDeltaV) return;
      tx /= tl;
      tz /= tl;
      // 自然牵引方向（进动相位）向拦截方向最多偏 maxBias
      const n = x.naturalTractionDir;
      const off = ang(n.x, n.z, tx, tz);
      const rot = Math.max(-T.maxBias, Math.min(T.maxBias, off));
      const cr = Math.cos(rot);
      const sr = Math.sin(rot);
      const dx = n.x * cr - n.z * sr;
      const dz = n.x * sr + n.z * cr;
      const toward = dx * tx + dz * tz;
      c.natSum += Math.abs(off);
      c.biasSum += Math.abs(ang(dx, dz, tx, tz));
      c.n++;
      const pu = this.push[i];
      pu.tx = tx;
      pu.tz = tz;
      if (toward <= 0) return; // 偏转后仍背离对手：不施力
      const along = v.x * dx + v.z * dz;
      if (along >= T.maxSpeed) return;
      const ratio = x.spinRatio;
      const accel = Math.min(T.maxAccel, BEY_TUNING.driveAccel * BEY_TUNING.edgeGrip * ratio);
      const dv = Math.min(accel * dt, T.maxSpeed - along, T.maxDeltaV - c.deltaV[i]);
      if (dv <= 0) return;
      const m = x.body.mass();
      x.body.applyImpulse({ x: dx * dv * m, y: 0, z: dz * dv * m }, true);
      // 转速消耗：与原有轴心牵引相同的规则（driveSpinCost × 等效咬合），等效咬合按实际加速度折算
      const gEff = BEY_TUNING.edgeGrip * (dv / dt) / Math.max(1e-6, BEY_TUNING.driveAccel * BEY_TUNING.edgeGrip * ratio);
      const cost = BEY_TUNING.driveSpinCost * gEff * x.spinInertiaRatio * dt;
      x.loseSpin(cost);
      c.assistSpinCost[i] += cost;
      c.deltaV[i] += dv;
      c.pushSteps[i]++;
      pu.on = true;
      pu.dx = dx;
      pu.dz = dz;
      c.biasAngleMax = Math.max(c.biasAngleMax, (Math.abs(ang(dx, dz, tx, tz)) * 180) / Math.PI);
    });
  }

  private finish(time: number, exit: R1cExit, a: BeyPhysics, b: BeyPhysics): void {
    const c = this.cur!;
    c.t1 = time;
    c.exit = exit;
    c.spinLoss = [a, b].map((x, i) => c.spin0[i] - x.spin);
    c.biasAngleMean = c.n ? (c.biasSum / c.n) * (180 / Math.PI) : 0;
    c.naturalAngleMean = c.n ? (c.natSum / c.n) * (180 / Math.PI) : 0;
    const { biasSum: _b, natSum: _n, n: _c, ...rec } = c;
    void _b;
    void _n;
    void _c;
    this.log.push(rec);
    this.cur = null;
    this.enter('cooldown');
  }
}
