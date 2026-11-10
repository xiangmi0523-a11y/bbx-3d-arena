/**
 * 爆裂系统（产品总方案 v2.0 §6.3 / R4）——纯逻辑，不依赖 Rapier / Three.js，可在 Node 里确定性测试。
 *
 * ── 唯一输入 ──
 * ContactService 给出的“两台陀螺之间、本步求解器接触点匹配到的法向冲量之和”（实测，N·s，
 * 见 src/game/physics/ContactService.ts 的 BodyPairContact.normalImpulse）。
 * 不使用：jSmash（游戏推导量）、切向摩擦冲量（Rapier 0.19.3 运行时不写回，不可用）、能量转化（E7 账本未完成前不引入）。
 * 场地（墙、地面）接触不计入：地面支撑力每步都有冲量，计入会让静止的陀螺也积累应力。
 *
 * ── 接触段（观测概念，不是玩法状态） ──
 * 法向冲量 > 0 的步为“确认接触”；两次确认接触的间隔 ≤ holdTime 视为同一段（与 contactFeedback 的段定义一致）。
 *
 * ── 应力 ──
 * Δstress = kBurst × 冲量 / (lock × burstGuard)。lock 来自 Ratchet（锁扣强度），burstGuard 来自 Bit（轴粗的抽象）。
 * 在段内逐步累加：一段结束时的总增量 = kBurst × Σ段冲量 / (lock × burstGuard)，与“段结束时一次性结算”相同，
 * 区别只在爆裂发生在真正撞击的那一步，而不是段结束后再过 holdTime。回合内不衰减、不随机。
 * stress ≥ threshold 即爆裂（不可逆）。kBurst = null 表示尚未标定：只观测、不判定爆裂。
 */

import { SPIN_TIE_RATIO } from './match';

export const BURST_TUNING = {
  /**
   * 爆裂应力系数 k_burst（应力 / (N·s)，已除以 lock × burstGuard）。
   * null = 未标定：只统计接触段与应力，不触发爆裂。
   * M2 标定（tests/diag/m2-experiment.diag.ts C 部分，v2.0 签名矩阵 4×4×20 = 320 回合，固定种子，离线精确扫描）：
   * 按 §5.4 标准场爆裂终结目标 15–25% 取中值 20% → 0.00224（15–25% 对应约 0.00210–0.00240，爆裂占比随 k 变化很陡）。
   * 单次重击段（Σ ≈ 26 N·s）的应力增量：紫曜（lock × burstGuard = 0.25）≈ 0.23，森衡（0.64）≈ 0.09。
   * 这是 [待验证] 的初值：Bit 的 burstGuard 初值与平衡调参（M5）完成后需重新标定。
   */
  kBurst: 0.00224 as number | null,
  /** 接触段内两次确认接触的最大间隔（秒） */
  holdTime: 0.1,
  /** 爆裂阈值 */
  threshold: 1,
};

/** 一台陀螺的抗爆参数：Ratchet.lock × Bit.burstGuard 是唯一的抗爆组合 */
export interface BurstResistance {
  lock: number;
  burstGuard: number;
}

/** 一个接触段（两台陀螺之间） */
export interface ContactEpisode {
  /** 段序号（从 1 开始） */
  index: number;
  /** 第一次 / 最后一次确认接触的步号 */
  startStep: number;
  lastStep: number;
  /** 段内确认接触的步数 */
  touchSteps: number;
  /** 段内法向冲量之和与单步峰值（N·s） */
  sumImpulse: number;
  peakImpulse: number;
}

/**
 * 接触段跟踪：每个物理步调用一次 step(步号, 本步法向冲量)。
 * 段在最后一次确认接触之后超过 holdSteps 步仍无接触时结束，结束的那一步返回该段。
 */
export class EpisodeTracker {
  readonly holdSteps: number;
  current: ContactEpisode | null = null;
  count = 0;

  constructor(dt: number, holdTime = BURST_TUNING.holdTime) {
    this.holdSteps = Math.max(0, Math.round(holdTime / dt));
  }

  step(step: number, impulse: number): ContactEpisode | null {
    let closed: ContactEpisode | null = null;
    const c = this.current;
    if (c && step - c.lastStep > this.holdSteps) {
      closed = c;
      this.current = null;
    }
    if (impulse > 0) {
      let e = this.current;
      if (!e) {
        e = { index: ++this.count, startStep: step, lastStep: step, touchSteps: 0, sumImpulse: 0, peakImpulse: 0 };
        this.current = e;
      }
      e.lastStep = step;
      e.touchSteps++;
      e.sumImpulse += impulse;
      if (impulse > e.peakImpulse) e.peakImpulse = impulse;
    }
    return closed;
  }

  /** 回合结束：结束当前段（如有） */
  flush(): ContactEpisode | null {
    const c = this.current;
    this.current = null;
    return c;
  }

  /** 新回合：清空 */
  reset(): void {
    this.current = null;
    this.count = 0;
  }
}

/** 某一步发生爆裂的一方（下标 0 / 1）；同一步双方都达到阈值时两者都在列表里 */
export type BurstHits = number[];

/**
 * 双方爆裂应力（下标 0 = player，1 = rival）。
 * 只读冲量、不改物理；爆裂后不再累积（回合由比赛规则结束）。
 */
export class BurstMeter {
  readonly stress: [number, number] = [0, 0];
  /** 已爆裂的一方（第一次达到阈值的那一步记录），未爆裂为空 */
  readonly burst: number[] = [];
  /** 爆裂发生的步号 */
  burstStep = -1;
  /** 本回合每一方单段最大应力增量（结算 / 诊断用） */
  readonly peakEpisodeDelta: [number, number] = [0, 0];
  private readonly divisor: [number, number];
  private episodeDelta: [number, number] = [0, 0];

  constructor(
    res: [BurstResistance, BurstResistance],
    readonly k: number | null = BURST_TUNING.kBurst,
    readonly threshold = BURST_TUNING.threshold,
  ) {
    this.divisor = [Math.max(1e-6, res[0].lock * res[0].burstGuard), Math.max(1e-6, res[1].lock * res[1].burstGuard)];
  }

  /** 是否启用判定（已标定） */
  get active(): boolean {
    return this.k !== null;
  }

  /**
   * 本步两台陀螺之间的法向冲量（实测）。返回本步新爆裂的一方（没有则为空数组）。
   * spin：双方当前转速比例。同一步双方同时达到阈值（只会发生在 lock × burstGuard 完全相同的组合，
   * 例如镜像对局——同一份冲量、同一个分母）时，转得更慢的一方爆裂：锁扣被反向力矩顶开，角动量越小越难抵抗。
   * 不传 spin 或转速完全相同则双方都爆裂（规则判同时终结）。
   */
  add(step: number, impulse: number, spin?: [number, number]): BurstHits {
    const hits: BurstHits = [];
    if (this.k === null || impulse <= 0 || this.burst.length) return hits;
    for (let i = 0; i < 2; i++) {
      const d = (this.k * impulse) / this.divisor[i];
      this.stress[i] = Math.min(this.threshold, this.stress[i] + d);
      this.episodeDelta[i] += d;
      if (this.episodeDelta[i] > this.peakEpisodeDelta[i]) this.peakEpisodeDelta[i] = this.episodeDelta[i];
      if (this.stress[i] >= this.threshold) hits.push(i);
    }
    // 同一步双方都到阈值（分母 lock × burstGuard 相同的组合必然如此，因为冲量是双方共用的同一份实测值）：
    // 产品决定 D3——转速（绝对值，rad/s）更低的一方爆裂；两方转速在判定精度 SPIN_TIE_RATIO 内相同 → 双方同时爆裂，
    // 由回合裁判按“同时终结”判平局。全部是确定性比较，不引入随机。
    if (hits.length === 2 && spin) {
      const [s0, s1] = spin;
      if (Math.abs(s0 - s1) > SPIN_TIE_RATIO * Math.max(s0, s1, 1e-9)) {
        const keep = s0 < s1 ? 0 : 1;
        hits.length = 0;
        hits.push(keep);
        // 没爆裂的一方停在阈值之下（回合即将由规则结束，只影响显示）
        this.stress[1 - keep] = Math.min(this.stress[1 - keep], this.threshold * 0.999);
      }
    }
    if (hits.length) {
      this.burst.push(...hits);
      this.burstStep = step;
    }
    return hits;
  }

  /** 接触段结束（统计单段增量用） */
  endEpisode(): void {
    this.episodeDelta = [0, 0];
  }

  /** 某一方在某一段冲量下的应力增量（展示 / 诊断） */
  deltaFor(side: number, sumImpulse: number): number {
    return this.k === null ? 0 : (this.k * sumImpulse) / this.divisor[side];
  }

  reset(): void {
    this.stress[0] = this.stress[1] = 0;
    this.burst.length = 0;
    this.burstStep = -1;
    this.peakEpisodeDelta[0] = this.peakEpisodeDelta[1] = 0;
    this.episodeDelta = [0, 0];
  }
}

/**
 * 接触段 + 爆裂应力的组合（对战系统与诊断共用同一份段定义）。
 * 每个物理步调用一次 step(步号, 本步两台之间的法向冲量)。
 */
export class BurstObserver {
  readonly episodes: EpisodeTracker;
  readonly meter: BurstMeter;
  /** 本回合已结束的接触段（按时间顺序） */
  readonly closed: ContactEpisode[] = [];

  constructor(dt: number, res: [BurstResistance, BurstResistance], k: number | null = BURST_TUNING.kBurst) {
    this.episodes = new EpisodeTracker(dt);
    this.meter = new BurstMeter(res, k);
  }

  step(step: number, impulse: number, spin?: [number, number]): BurstHits {
    const done = this.episodes.step(step, impulse);
    if (done) {
      this.closed.push(done);
      this.meter.endEpisode();
    }
    return this.meter.add(step, impulse, spin);
  }

  /** 回合结束：收尾当前段 */
  finish(): void {
    const c = this.episodes.flush();
    if (c) {
      this.closed.push(c);
      this.meter.endEpisode();
    }
  }

  /** 本回合最大单段冲量（结算“最大冲击”） */
  get maxEpisodeImpulse(): number {
    let m = this.episodes.current?.sumImpulse ?? 0;
    for (const e of this.closed) if (e.sumImpulse > m) m = e.sumImpulse;
    return m;
  }

  /** 本回合接触段数（含进行中的段） */
  get episodeCount(): number {
    return this.episodes.count;
  }
}
