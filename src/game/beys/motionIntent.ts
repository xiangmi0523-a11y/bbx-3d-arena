import { ARENA } from '../arena/arenaSpec';
import type { AssembledBey } from './parts/assemble';

/**
 * 自主运动的战术意图层（不依赖 Rapier，可单独测试）。
 *
 * 它不施加任何力，也不改速度 / 位置。它只输出两样东西：
 *  - heading：希望轴心牵引指向的水平方向（弧度，atan2(z, x)）；
 *  - authority：0..AUTHORITY_CAP（< 1），对“进动相位转动快慢”的调制深度。
 * BeyPhysics 用它调节进动相位的转速：牵引方向接近 heading 时进动放慢、背离时加快，
 * 相位仍然始终沿自然方向转动（authority < 1 时转速永远 > 0），所以花瓣轨迹、惯性、碰撞后的方向变化都保留，
 * 意图只让“朝某个方向推”的时间多一点。牵引力大小、上限和转速消耗仍由轴心物理公式决定。
 *
 * 决策是有状态的：每个状态有最短 / 最长持续时间，切换带滞回；
 * 随机选择（环绕方向、切入角、持续时间）来自每台陀螺自己的确定性随机数（mulberry32），固定种子可复现。
 */

export type IntentState = 'roam' | 'orbit' | 'cut' | 'contact' | 'disengage' | 'guard' | 'evade' | 'breakout';

/** 意图调参（物理含义见报告） */
export const INTENT_TUNING = {
  /** 调制深度上限：< 1 保证进动相位不会被锁死在某个方向（不会退化成“一直正对对手冲”） */
  authorityCap: 0.9,
  /** 低于这个转速比例后意图逐渐失效（轴心倾角变小、能利用的牵引变弱） */
  spinFloor: 0.35,
  /** 切入：远处的偏转角范围（度），越近越正，贴近时 = 0（正面接触） */
  cutAngleMin: 25,
  cutAngleMax: 55,
  /** 切入角从这个外沿距离开始收窄到 0（米） */
  cutNear: 0.4,
  cutFar: 2.4,
  /** 切入最长持续（秒），超时没撞上就转为环绕、换一个角度再来 */
  cutMin: 1.4,
  cutMax: 2.4,
  /** 环绕：外沿间距（米）与持续时间（秒） */
  orbitGapMin: 0.7,
  orbitGapMax: 1.6,
  orbitMin: 0.6,
  orbitMax: 1.6,
  /** 接触中：沿切向滑开的期望速度、向外的期望速度（m/s）与调制深度 */
  slideSpeed: 1.5,
  slideAway: 0.8,
  contactA: 0.4,
  /** 脱离：至少持续这么久、拉开到这个外沿间距（米）或超时后重新决策 */
  disengageMin: 0.1,
  disengageGap: 0.4,
  disengageMax: 0.9,
  /** 守中 / 游走的重新决策间隔（秒） */
  idleMin: 0.8,
  idleMax: 1.6,
  /** 闪避触发：对手外沿距离 < evadeGap 且接近速度 > evadeClosing；离开条件放宽 1.5 倍（滞回） */
  evadeGap: 1.2,
  evadeClosing: 1.5,
  /** 靠近墙边（半径 > edgeR）时期望速度去掉朝外的分量，并加最多 edgePull m/s 朝内的分量 */
  edgeR: 3.4,
  edgePull: 1.0,
  /** 墙边判断用的预测时间（秒） */
  edgeLook: 0.45,
  /** 期望速度（m/s）：切入 = cutSpeed + cutSpeedAttack × 攻击值；环绕同理 */
  cutSpeed: 2.0,
  /** 切入时额外抵消的绕行切向速度比例 */
  cutCancel: 3.0,
  cutSpeedAttack: 2.2,
  orbitSpeed: 1.4,
  orbitSpeedAttack: 1.4,
  /** 各状态的调制深度：切入 = cutA0 + cutA1 × 攻击值；环绕同理 */
  cutA0: 0.6,
  cutA1: 0.35,
  orbitA0: 0.45,
  orbitA1: 0.3,
  /** 速度误差达到这个值（m/s）时意图满量 */
  errFull: 0.5,
  /** 接触判定的额外间隙（米），与诊断一致 */
  touchSlack: 0.03,
};

/** 由现有配件属性推出的运动倾向（不另造参数体系） */
export interface MotionProfile {
  /** 进攻性：刀刃攻击值减去一半防御值 */
  aggression: number;
  /** 稳守：刀刃防御值 */
  steadiness: number;
  /** 节能：轴心转速衰减越小、刀刃配重越靠外缘越想省转速（耐力套装 ≈ 1，其余 ≤ 0.25） */
  economy: number;
  /** 轴心把倾斜转化为移动的能力（自然倾角越大越能“带着方向走”） */
  tipAuthority: number;
  attack: number;
}

export function profileOf(spec: AssembledBey): MotionProfile {
  const c = (v: number) => Math.max(0, Math.min(1, v));
  return {
    aggression: c(spec.blade.attack - 0.5 * spec.blade.defense),
    steadiness: c(spec.blade.defense),
    economy: c(1 - (spec.tip.spinDecay - 0.85) / 1.15) * c((spec.blade.rimWeight - 0.45) / 0.3),
    tipAuthority: 0.3 + 0.7 * c(spec.tip.drift / 0.16),
    attack: c(spec.blade.attack),
  };
}

export interface IntentInput {
  dt: number;
  px: number;
  pz: number;
  vx: number;
  vz: number;
  ox: number;
  oz: number;
  ovx: number;
  ovz: number;
  /** 两台刀刃半径之和（接触判定）与外缘半径之和（间距） */
  bladeSum: number;
  outerSum: number;
  spinRatio: number;
  oppSpinRatio: number;
  /** 对手的进攻性（决定是否需要闪避） */
  oppAggression: number;
}

export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const DEG = Math.PI / 180;

export class MotionIntent {
  state: IntentState = 'roam';
  /** 在当前状态已停留的时间（秒） */
  time = 0;
  /** 当前状态计划持续时间（秒） */
  private hold = 0.5;
  heading = 0;
  authority = 0;
  /** 环绕 / 切入的方向（+1 / −1） */
  private side = 1;
  private cutAngle = 40 * DEG;
  private orbitGap = 1;
  /** 状态切换次数（诊断） */
  switches = 0;
  readonly profile: MotionProfile;
  private readonly rng: () => number;

  constructor(spec: AssembledBey, seed: number) {
    this.profile = profileOf(spec);
    this.rng = mulberry32(seed);
    this.side = this.rng() < 0.5 ? 1 : -1;
  }

  private range(a: number, b: number): number {
    return a + (b - a) * this.rng();
  }

  /** 诊断：进入各状态的次数；切入以接触结束的次数 */
  readonly stats: Record<string, number> = { cutHit: 0 };

  private enter(s: IntentState, hold: number): void {
    if (s !== this.state) this.switches++;
    if (s === 'contact' && this.state === 'cut') this.stats.cutHit++;
    this.stats[s] = (this.stats[s] ?? 0) + 1;
    this.state = s;
    this.time = 0;
    this.hold = hold;
  }

  /** 外部（僵持脱困）强制进入 breakout，结束后回到正常决策 */
  forceBreakout(duration: number): void {
    this.enter('breakout', duration);
  }

  /** 选择下一个战术状态（只在状态结束时调用，不逐帧随机） */
  private decide(inp: IntentInput, gap: number): void {
    const T = INTENT_TUNING;
    const P = this.profile;
    // 局势：转速领先的一方不急着进攻，落后的一方更主动（平衡型对局势最敏感）
    const lead = inp.spinRatio - inp.oppSpinRatio;
    const flexibility = 1 - Math.abs(P.aggression - 0.45) * 2; // 平衡型 ≈ 1，攻击 / 防御型 ≈ 0.3
    let pCut = P.aggression * 1.1 - lead * 0.8 * Math.max(0, flexibility);
    pCut = Math.max(0, Math.min(0.95, pCut));
    const r = this.rng();
    if (r < pCut && gap < 4) {
      this.side = this.rng() < 0.5 ? 1 : -1;
      this.cutAngle = this.range(T.cutAngleMin, T.cutAngleMax) * DEG;
      this.enter('cut', this.range(T.cutMin, T.cutMax));
    } else if (P.aggression > 0.2 && r < pCut + 0.5) {
      if (this.rng() < 0.35) this.side = -this.side;
      this.orbitGap = this.range(T.orbitGapMin, T.orbitGapMax);
      this.enter('orbit', this.range(T.orbitMin, T.orbitMax) * (1.2 - 0.5 * P.aggression));
    } else if (P.steadiness >= P.economy * 0.8) {
      this.enter('guard', this.range(T.idleMin, T.idleMax));
    } else {
      this.enter('roam', this.range(T.idleMin, T.idleMax));
    }
  }

  update(inp: IntentInput): void {
    const T = INTENT_TUNING;
    const P = this.profile;
    this.time += inp.dt;
    const dx = inp.ox - inp.px;
    const dz = inp.oz - inp.pz;
    const d = Math.hypot(dx, dz) || 1e-6;
    const gap = d - inp.outerSum;
    const touching = d < inp.bladeSum + T.touchSlack;
    const bearing = Math.atan2(dz, dx);
    // 对手接近速度（正 = 在靠近）
    const closing = -((inp.ovx - inp.vx) * dx + (inp.ovz - inp.vz) * dz) / d;

    // 1) 物理事件驱动的切换：接触 → contact，分开 → disengage
    if (this.state === 'breakout') {
      if (this.time >= this.hold) this.enter('disengage', T.disengageMin);
    } else if (touching) {
      if (this.state !== 'contact') this.enter('contact', 0);
    } else if (this.state === 'contact') {
      this.enter('disengage', this.range(T.disengageMin, T.disengageMin * 2));
    } else if (this.state === 'disengage') {
      // 进攻性越强，脱离越短（尽快寻找下一次机会）
      if (this.time >= this.hold && (gap > T.disengageGap || this.time > T.disengageMax * (1 - 0.5 * P.aggression))) this.decide(inp, gap);
    } else if (this.state === 'evade') {
      // 滞回：威胁解除（拉开到 1.5 倍触发距离或不再接近）且至少躲了 0.3 秒才结束
      if (this.time > 0.3 && (gap > T.evadeGap * 1.5 || closing < 0.3)) this.decide(inp, gap);
    } else {
      const threatened = P.economy > 0.5 && inp.oppAggression > 0.4 && gap < T.evadeGap && closing > T.evadeClosing;
      if (threatened && this.state !== 'cut') {
        this.side = Math.sin(wrap(Math.atan2(inp.ovz, inp.ovx) - bearing)) > 0 ? -1 : 1;
        this.enter('evade', 0.3);
      } else if (this.time >= this.hold) {
        if (this.state === 'cut') {
          // 切入超时没撞上：换一侧重新切入，或先环绕一下（不会一直沿同一条线追）
          this.side = -this.side;
          if (this.rng() < P.aggression) {
            this.cutAngle = this.range(T.cutAngleMin, T.cutAngleMax) * DEG;
            this.enter('cut', this.range(T.cutMin, T.cutMax));
          } else {
            this.orbitGap = this.range(T.orbitGapMin, T.orbitGapMax);
            this.enter('orbit', this.range(T.orbitMin, T.orbitMax));
          }
        } else this.decide(inp, gap);
      }
    }

    // 2) 各状态的期望速度 → 期望牵引方向 = (期望速度 − 当前速度) 的方向。
    // 牵引只在“沿牵引方向的速度低于上限”时出力，所以指向与当前速度相反时就是轴心摩擦刹车：
    // 太快 / 方向偏了会被修正，而不是一直加速冲出大圈。差值很小时意图自动减弱，交给自然进动。
    let wx = 0;
    let wz = 0;
    let a = 0;
    const speed = Math.hypot(inp.vx, inp.vz);
    switch (this.state) {
      case 'cut': {
        // 斜向切入：瞄对手的预判位置，远处偏开 cutAngle 走弧线，越近越正
        const lead = Math.min(0.5, d / Math.max(2, speed));
        const ax = inp.ox + inp.ovx * lead - inp.px;
        const az = inp.oz + inp.ovz * lead - inp.pz;
        const k = Math.max(0, Math.min(1, (gap - T.cutNear) / (T.cutFar - T.cutNear)));
        const h = Math.atan2(az, ax) + this.side * this.cutAngle * k;
        // 切入时不刹车：沿切入方向已经比期望速度快就保持（撞击力度来自接近速度），只修正偏离的分量
        const along = Math.max(0, inp.vx * Math.cos(h) + inp.vz * Math.sin(h));
        const v = Math.max(T.cutSpeed + T.cutSpeedAttack * P.attack, along);
        wx = Math.cos(h) * v;
        wz = Math.sin(h) * v;
        // 防“绕着对手转圈”：相对速度里绕对手的切向分量额外抵消 cutCancel 倍。
        // 碗面重力本身就指向中心（防御型常在中心），只朝对手推会变成向心力、绕圈不靠近
        const ux = dx / d;
        const uz = dz / d;
        const rvx = inp.vx - inp.ovx;
        const rvz = inp.vz - inp.ovz;
        const rt = rvx * -uz + rvz * ux;
        wx -= -uz * rt * T.cutCancel;
        wz -= ux * rt * T.cutCancel;
        a = T.cutA0 + T.cutA1 * P.attack;
        break;
      }
      case 'orbit': {
        // 绕对手转：切向 ± 半径修正（间距大于目标就往里偏，小于就往外偏），叠加对手自身速度
        const err = Math.max(-1, Math.min(1, (gap - this.orbitGap) / 0.8));
        const h = bearing + this.side * (Math.PI / 2 - err * 0.6);
        const v = T.orbitSpeed + T.orbitSpeedAttack * P.attack;
        wx = Math.cos(h) * v + inp.ovx * 0.5;
        wz = Math.sin(h) * v + inp.ovz * 0.5;
        a = T.orbitA0 + T.orbitA1 * P.attack;
        break;
      }
      case 'contact': {
        // 接触中的调整：顺着两者相对滑动的切向滑开、略向外（不是硬推开：力仍是轴心牵引，接触冲量由刚体求解）
        const ux = dx / d;
        const uz = dz / d;
        const rtx = inp.vx - inp.ovx;
        const rtz = inp.vz - inp.ovz;
        const sgn = rtx * -uz + rtz * ux >= 0 ? 1 : -1;
        wx = -uz * sgn * T.slideSpeed - ux * T.slideAway;
        wz = ux * sgn * T.slideSpeed - uz * T.slideAway;
        a = T.contactA;
        break;
      }
      case 'disengage': {
        // 顺着碰撞后的运动方向离开，再略向背离对手的一侧偏（不是固定角度后退）
        const v = Math.max(1.2, Math.min(speed, 3));
        const vh = speed > 0.3 ? Math.atan2(inp.vz, inp.vx) : bearing + Math.PI;
        const h = vh + wrap(bearing + Math.PI - vh) * 0.35;
        wx = Math.cos(h) * v;
        wz = Math.sin(h) * v;
        a = 0.3;
        break;
      }
      case 'guard': {
        // 守中：期望速度 = 缓慢回到中心（平台内为 0，即轴心摩擦帮它稳住，不追不跑）
        const r = Math.hypot(inp.px, inp.pz);
        const v = Math.min(1, Math.max(0, (r - 0.5) * 0.8));
        if (r > 1e-3) {
          wx = (-inp.px / r) * v;
          wz = (-inp.pz / r) * v;
        }
        a = 0.25 + 0.35 * P.steadiness;
        break;
      }
      case 'evade': {
        // 闪避：向对手来路的侧面让开
        const h = Math.atan2(inp.ovz, inp.ovx) + this.side * (Math.PI / 2);
        wx = Math.cos(h) * 2;
        wz = Math.sin(h) * 2;
        a = 0.4;
        break;
      }
      default:
        a = 0;
    }

    // 3) 墙边：期望速度去掉朝外的分量，并按深入外圈的程度加一点朝内的分量。
    // 期望方向 = 期望速度 − 当前速度，所以正在冲向墙时牵引会转成刹车（轴心摩擦），而不是继续推着撞墙
    // 用 edgeLook 秒后的预测位置判断（高速时提前开始修正，牵引转向需要时间）
    const fx = inp.px + inp.vx * T.edgeLook;
    const fz = inp.pz + inp.vz * T.edgeLook;
    const r = Math.max(Math.hypot(inp.px, inp.pz), Math.hypot(fx, fz));
    if (a > 0 && r > T.edgeR) {
      const fr = Math.hypot(fx, fz) || 1;
      const ex = fx / fr;
      const ez = fz / fr;
      const out = wx * ex + wz * ez;
      const w = Math.min(1, (r - T.edgeR) / (ARENA.radius - 0.6 - T.edgeR));
      const pull = T.edgePull * w;
      if (out > -pull) {
        wx -= ex * (out + pull);
        wz -= ez * (out + pull);
      }
    }
    const ex0 = wx - inp.vx;
    const ez0 = wz - inp.vz;
    const err = Math.hypot(ex0, ez0);
    const heading = err > 1e-3 ? Math.atan2(ez0, ex0) : this.heading;
    // 速度已经接近期望：意图减弱（误差 errFull 以上才全量）
    a *= Math.min(1, err / T.errFull);

    // 4) 调制深度受轴心和剩余转速限制
    const spinK = Math.max(0, Math.min(1, (inp.spinRatio - 0.1) / (T.spinFloor - 0.1)));
    this.authority = Math.min(T.authorityCap, a * P.tipAuthority * spinK);
    this.heading = heading;
  }
}
