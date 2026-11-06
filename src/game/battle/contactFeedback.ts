/**
 * 接触反馈状态机（纯逻辑，不依赖 Three.js / Web Audio / Rapier，可在 Node 里确定性测试）。
 *
 * 问题（见 p2.3.2 报告的接触段诊断）：原来只有 Rapier 的“开始接触”事件会触发 resolveSmash，
 * 每次接触只在开头结算并反馈一次；两台陀螺贴着互相刮擦时，Rapier 实际给出的是一串 1–3 步的
 * 微接触（刀刃凸起一下下地碰），大部分低于撞击事件门槛，没有任何声音和火花。
 *
 * 这里把三层反馈放进同一个接触生命周期里：
 *  - 接触段（episode）：本步 Rapier 接触流形里有法向冲量 = 真实接触。
 *    最后一次真实接触后 holdTime 内再次接触，算同一段（刀刃凸起的颤动接触），超过就结束；
 *  - A 轻擦（graze）：接触段刚开始、累计接触时间还很短。反馈强度按真实法向力和滑动速度，再乘 grazeGain；
 *  - B 持续摩擦（grind）：接触段持续超过 grindOnset 且真实接触步数够多。强度连续变化，
 *    音频和火花都是持续的、随强度调制的，而不是每步播放一次撞击；
 *  - C 强碰撞：仍由 BattleSystem.resolveSmash 的 ImpactEvent 产生（物理完全不变），
 *    这里只登记它属于哪个接触段，并在中等 / 猛撞后短暂压低摩擦层（ducking），避免摩擦声和火花把重击淹没；
 *    同一接触段内紧跟着的、更弱的强碰撞反馈会被合并（物理冲量照常施加，只是不重复播放）；
 *    已进入持续摩擦后，颤动接触产生的轻擦撞击并入摩擦层，不再一下一下单独播放。
 *
 * 本模块只读取物理状态，不施加任何力或冲量。
 */
import type { ImpactTier } from './impactTiers';

export type ContactPhase = 'idle' | 'graze' | 'grind';

export interface ContactSample {
  /** 本步是否有真实接触（Rapier 法向接触冲量 > 0） */
  touching: boolean;
  /** 本步法向接触力（N）= 法向冲量 / 步长 */
  force: number;
  /** 接触面切向相对滑动速度（m/s，包含转速带来的表面速度） */
  slide: number;
  /** 接触点（世界坐标） */
  x: number;
  y: number;
  z: number;
  /** 水平法线（player → rival） */
  nx: number;
  nz: number;
  /** 滑动方向（水平单位向量） */
  tx: number;
  tz: number;
}

export const CONTACT_TUNING = {
  /** 两次真实接触间隔不超过它算同一接触段（秒）。诊断：贴身刮擦时微接触间隔多在 0.02–0.1 s */
  holdTime: 0.1,
  /** 接触段持续多久后进入持续摩擦（秒） */
  grindOnset: 0.1,
  /** 进入持续摩擦至少需要的真实接触步数（120 Hz），避免两次孤立的擦碰被当成摩擦 */
  grindMinSteps: 4,
  /** 法向力参考值（N）：达到它压力项满额。诊断：贴身刮擦时法向力均值 6–95 N，撞击瞬间上千 N */
  forceRef: 140,
  /** 滑动速度参考值（m/s） */
  slideRef: 45,
  /** 滑动速度低于它几乎没有刮擦（同向转动、接触面一起走） */
  slideMin: 1.5,
  /** 轻擦阶段的强度系数 */
  grazeGain: 0.45,
  /**
   * 强度上升：每个真实接触步向目标靠近的比例（接触本身就是瞬时的，上升不做慢平滑；
   * 音频 / 辉光各自还有 15–30 ms 的平滑）。下降时间常数（秒）：颤动接触之间不会断断续续
   */
  attack: 0.7,
  release: 0.09,
  /** 中等 / 猛撞后摩擦层被压低的时间（秒），压低到 duckFloor，再线性恢复 */
  duckMedium: 0.14,
  duckHeavy: 0.3,
  duckFloor: 0.15,
  /** 同一接触段内，距上一次强碰撞反馈不足它、且不更强的强碰撞只算物理不重复反馈（秒） */
  mergeWindow: 0.12,
  /** 摩擦中并入的轻擦撞击把摩擦强度至少推到 absorbBump + 撞击力度 */
  absorbBump: 0.3,
};

export interface ContactState {
  phase: ContactPhase;
  /** 0..1：已经包含轻擦系数和强碰撞压低 */
  level: number;
  /** 未压低的强度（测试 / 诊断用） */
  rawLevel: number;
  /** 当前接触段编号（从 1 开始；idle 时为最近一段的编号） */
  episode: number;
  /** 当前接触段已持续时间 */
  episodeAge: number;
  /** 当前接触段真实接触步数 */
  touchSteps: number;
  force: number;
  slide: number;
  x: number;
  y: number;
  z: number;
  nx: number;
  nz: number;
  tx: number;
  tz: number;
}

/**
 * play：播放这次撞击的反馈；
 * merge：同一接触段内紧跟着的、不更强的强碰撞，由前一次代表，不重复播放；
 * absorb：持续摩擦中刀刃颤动产生的轻擦撞击，并入摩擦层（推高一下摩擦强度），不单独“叮”一声。
 * 三种情况下物理冲量都已由 resolveSmash 照常施加。
 */
export type ImpactDecision = 'play' | 'merge' | 'absorb';

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 由真实法向力和滑动速度算出的目标强度（0..1） */
export function grindTarget(force: number, slide: number): number {
  const T = CONTACT_TUNING;
  if (force <= 0 || slide <= T.slideMin) return 0;
  const p = Math.sqrt(clamp01(force / T.forceRef));
  const s = clamp01((slide - T.slideMin) / (T.slideRef - T.slideMin));
  return clamp01(p * (0.35 + 0.65 * s));
}

export class ContactFeedback {
  readonly state: ContactState = {
    phase: 'idle',
    level: 0,
    rawLevel: 0,
    episode: 0,
    episodeAge: 0,
    touchSteps: 0,
    force: 0,
    slide: 0,
    x: 0,
    y: 0,
    z: 0,
    nx: 1,
    nz: 0,
    tx: 0,
    tz: 1,
  };
  /** 统计：接触段数、进入持续摩擦的段数、被合并的强碰撞反馈数、并入摩擦层的轻擦撞击数 */
  episodes = 0;
  grindEpisodes = 0;
  merged = 0;
  absorbed = 0;
  private time = 0;
  private lastTouch = -Infinity;
  private episodeStart = 0;
  private enteredGrind = false;
  private duckUntil = -Infinity;
  private duckLen = 0;
  private lastStrong: { t: number; strength: number; episode: number } | null = null;

  /** 每个物理步调用一次；sample 为 null 表示两台陀螺离得远、本步没有查询接触 */
  step(dt: number, sample: ContactSample | null): void {
    const T = CONTACT_TUNING;
    const s = this.state;
    this.time += dt;
    const touching = !!sample?.touching;

    if (touching) {
      if (s.phase === 'idle') this.open();
      this.lastTouch = this.time;
      s.touchSteps++;
      s.force = sample!.force;
      s.slide = sample!.slide;
      s.x = sample!.x;
      s.y = sample!.y;
      s.z = sample!.z;
      s.nx = sample!.nx;
      s.nz = sample!.nz;
      s.tx = sample!.tx;
      s.tz = sample!.tz;
    } else if (s.phase !== 'idle' && this.time - this.lastTouch > T.holdTime) {
      // 接触段结束：状态清零，强度按 release 自然衰减到 0（不突然掐断）
      s.phase = 'idle';
      s.force = 0;
    }

    if (s.phase !== 'idle') {
      s.episodeAge = this.time - this.episodeStart;
      if (!this.enteredGrind && s.episodeAge >= T.grindOnset && s.touchSteps >= T.grindMinSteps) {
        this.enteredGrind = true;
        this.grindEpisodes++;
      }
      s.phase = this.enteredGrind ? 'grind' : 'graze';
    }

    // 目标强度：只在真实接触的步上有值；颤动接触之间靠 release 平滑衔接
    const target = touching ? grindTarget(s.force, s.slide) * (s.phase === 'grind' ? 1 : T.grazeGain) : 0;
    if (target > s.rawLevel) s.rawLevel += (target - s.rawLevel) * T.attack;
    else s.rawLevel += (target - s.rawLevel) * (1 - Math.exp(-dt / T.release));
    if (s.phase === 'idle' && s.rawLevel < 0.002) s.rawLevel = 0;

    let duck = 1;
    if (this.time < this.duckUntil) {
      const k = 1 - (this.duckUntil - this.time) / this.duckLen; // 0 → 1
      duck = T.duckFloor + (1 - T.duckFloor) * k;
    }
    s.level = s.rawLevel * duck;
  }

  /**
   * 登记一次强碰撞事件（ImpactEvent），返回是否播放反馈。
   * 物理冲量已经由 resolveSmash 施加，这里只决定视听反馈。
   */
  impact(tier: ImpactTier, strength: number): ImpactDecision {
    const T = CONTACT_TUNING;
    const s = this.state;
    // 撞击结算由 Rapier 的“开始接触”事件触发，个别情况下本步求解器还没给出法向冲量（预测距离内的接触），
    // 这时也开启一个接触段，保证撞击和摩擦始终属于同一个生命周期
    if (s.phase === 'idle') this.open();
    const ep = s.episode;
    if (tier === 'light') {
      if (s.phase !== 'grind') return 'play';
      // 摩擦中的颤动轻擦：推高摩擦强度（真实撞击力度越大推得越高），不单独播放
      this.absorbed++;
      s.rawLevel = Math.max(s.rawLevel, Math.min(1, T.absorbBump + strength));
      return 'absorb';
    }
    const prev = this.lastStrong;
    if (prev && prev.episode === ep && this.time - prev.t < T.mergeWindow && strength <= prev.strength) {
      this.merged++;
      return 'merge';
    }
    this.lastStrong = { t: this.time, strength, episode: ep };
    this.duckLen = tier === 'heavy' ? T.duckHeavy : T.duckMedium;
    this.duckUntil = this.time + this.duckLen;
    return 'play';
  }

  private open(): void {
    const s = this.state;
    this.episodes++;
    s.episode++;
    this.episodeStart = this.time;
    this.lastTouch = this.time;
    s.touchSteps = 0;
    s.episodeAge = 0;
    this.enteredGrind = false;
    s.phase = 'graze';
  }

  /** 对战结束 / 重开：清空 */
  reset(): void {
    const s = this.state;
    s.phase = 'idle';
    s.level = s.rawLevel = s.force = s.slide = 0;
    s.episodeAge = 0;
    s.touchSteps = 0;
    this.lastTouch = -Infinity;
    this.duckUntil = -Infinity;
    this.lastStrong = null;
  }
}
