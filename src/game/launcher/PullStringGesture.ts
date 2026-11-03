/**
 * 拉绳发射手势（纯逻辑，不依赖 DOM，便于测试和复用到 Capacitor 原生触摸）。
 *
 * 操作：手指按住拉绳把手 → 向下拉（拉得越长、松手瞬间越快，力度越大）
 *       → 左右偏移控制发射方向 → 松手发射。拉得太短视为取消。
 */

export interface LaunchCommand {
  /** 力度 0..1 */
  power: number;
  /** 方向 -1（偏左）..1（偏右） */
  aim: number;
  /** 发射倾角 0..1（P1 预留：倾斜发射） */
  tilt: number;
}

export interface PullState {
  active: boolean;
  /** 拉绳长度比例 0..1 */
  pull: number;
  aim: number;
  /** 当前拉动速度比例 0..1 */
  speed: number;
  /** 预估松手力度 */
  power: number;
  /** 指针相对起点的位移（px），供 UI 画绳子 */
  dx: number;
  dy: number;
}

export interface PullConfig {
  /** 拉满需要的像素距离 */
  maxPull: number;
  /** 低于这个比例松手视为取消 */
  minPull: number;
  /** 拉动速度达到多少 px/s 视为满速 */
  fullSpeed: number;
}

interface Sample {
  x: number;
  y: number;
  t: number;
}

export const IDLE_PULL: PullState = { active: false, pull: 0, aim: 0, speed: 0, power: 0, dx: 0, dy: 0 };

export class PullStringGesture {
  private cfg: PullConfig;
  private origin: Sample | null = null;
  private samples: Sample[] = [];
  private peakPull = 0;
  state: PullState = { ...IDLE_PULL };

  constructor(cfg: Partial<PullConfig> = {}) {
    this.cfg = { maxPull: 220, minPull: 0.18, fullSpeed: 1400, ...cfg };
  }

  configure(cfg: Partial<PullConfig>): void {
    this.cfg = { ...this.cfg, ...cfg };
  }

  get active(): boolean {
    return this.origin !== null;
  }

  start(x: number, y: number, t: number): PullState {
    this.origin = { x, y, t };
    this.samples = [{ x, y, t }];
    this.peakPull = 0;
    return this.update(x, y);
  }

  move(x: number, y: number, t: number): PullState {
    if (!this.origin) return this.state;
    this.samples.push({ x, y, t });
    // 只保留最近 120ms 的采样，用于计算松手瞬间速度
    while (this.samples.length > 2 && t - this.samples[0].t > 120) this.samples.shift();
    return this.update(x, y);
  }

  /** 松手：返回发射指令；拉得太短返回 null（取消） */
  end(t: number): LaunchCommand | null {
    if (!this.origin) return null;
    const { pull, aim } = this.state;
    const speed = this.speedRatio(t);
    const usedPull = Math.max(pull, this.peakPull * 0.9);
    this.reset();
    if (usedPull < this.cfg.minPull) return null;
    return { power: computePower(usedPull, speed), aim, tilt: 0 };
  }

  cancel(): void {
    this.reset();
  }

  private reset(): void {
    this.origin = null;
    this.samples = [];
    this.state = { ...IDLE_PULL };
  }

  private update(x: number, y: number): PullState {
    const o = this.origin!;
    const dx = x - o.x;
    const dy = y - o.y;
    const pull = clamp01(dy / this.cfg.maxPull);
    this.peakPull = Math.max(this.peakPull, pull);
    const aim = clamp(dx / (this.cfg.maxPull * 0.6), -1, 1);
    const last = this.samples[this.samples.length - 1];
    const speed = this.speedRatio(last ? last.t : o.t);
    this.state = { active: true, pull, aim, speed, power: computePower(pull, speed), dx, dy };
    return this.state;
  }

  private speedRatio(now: number): number {
    if (this.samples.length < 2) return 0;
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    // 松手距最后一次移动太久，说明手指已停住，不计速度
    if (now - last.t > 100) return 0;
    const dt = Math.max(1, last.t - first.t) / 1000;
    const vy = (last.y - first.y) / dt;
    return clamp01(vy / this.cfg.fullSpeed);
  }
}

/** 拉绳长度占 65%，松手速度占 35%，两者都满才是满力 */
export function computePower(pull: number, speed: number): number {
  return clamp01(0.65 * pull + 0.35 * speed * Math.min(1, pull / 0.5));
}

function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
