/**
 * 针尖僵持自适应滚动阻力（原型 V1）。
 *
 * 针尖对针尖在碗底长时间低速僵持时，原生接触摩擦产生的微小平动被游戏层滚动阻力
 * （BeyPhysics.preStep「轴心滚动 / 滑动阻力」）每步扣掉。确认僵持后只把这一项的减速度乘以 scale，
 * 解除后立即恢复。不改其他任何力、摩擦、转速衰减、牵引或碰撞。
 *
 * 确认僵持（全部满足并持续 dwell 秒；每步在 BattleSystem.preStep 开头用上一步结束时的状态判定）：
 *  - 双方都是针尖：轴心咬合度 gearGrip < 牵引门槛 driveMinGrip（目录中只有「针尖轴」满足）
 *  - 双方水平速度 < speed
 *  - 双方转速比例 spinRatio ≥ spinRatio（低转速区域交给原有 Wobble / 判定）
 *  - 距上一次几何接触或冲量响应超过 miss 步（BattleSystem.contactClass，Stage A 接触观测层）
 *  - 双方 breakout ≤ 0，死亡摇摆计时 wobbleFor = 0
 */
export const STALL_ROLL = {
  /** 确认僵持时滚动阻力倍率；1 = 关闭（与 Stage A 逐步相同） */
  scale: 0.5,
  dwell: 3,
  speed: 0.4,
  spinRatio: 0.4,
  miss: 6,
};

export interface StallRollInput {
  /** 双方轴心都没有牵引（针尖） */
  bothNeedle: boolean;
  /** 本步（上一步结束时）有几何接触或冲量响应 */
  contact: boolean;
  speedA: number;
  speedB: number;
  spinRatioA: number;
  spinRatioB: number;
  breakoutA: number;
  breakoutB: number;
  wobbleFor: number;
}

export class StallRollGate {
  /** 距上次接触的步数（开局视为很久以前） */
  miss = 99;
  /** 条件连续满足的时长（秒） */
  dwell = 0;
  /** 是否处于确认僵持 */
  confirmed = false;
  /** 诊断：确认僵持的步数与进入次数 */
  confirmedSteps = 0;
  entries = 0;

  step(s: StallRollInput, dt: number): boolean {
    const T = STALL_ROLL;
    this.miss = s.contact ? 0 : this.miss + 1;
    const ok =
      s.bothNeedle &&
      this.miss > T.miss &&
      s.speedA < T.speed &&
      s.speedB < T.speed &&
      s.spinRatioA >= T.spinRatio &&
      s.spinRatioB >= T.spinRatio &&
      s.breakoutA <= 0 &&
      s.breakoutB <= 0 &&
      s.wobbleFor === 0;
    this.dwell = ok ? this.dwell + dt : 0;
    const was = this.confirmed;
    this.confirmed = this.dwell >= T.dwell;
    if (this.confirmed) {
      this.confirmedSteps++;
      if (!was) this.entries++;
    }
    return this.confirmed;
  }

  /** 当前应使用的滚动阻力倍率 */
  get scale(): number {
    return this.confirmed ? STALL_ROLL.scale : 1;
  }
}
