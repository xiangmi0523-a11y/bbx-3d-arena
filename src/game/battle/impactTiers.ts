/**
 * 撞击力度分级与反馈参数（纯函数，可单元测试）。
 *
 * 力度 strength 0..1 来自物理：碰撞前一刻两台陀螺沿法线的接近速度 + 转速带来的接触面速度。
 * 三个等级的反馈必须明显不同，而不是所有碰撞都打满：
 *  - light  轻擦：几粒细火花、清脆的“叮”，几乎不震屏，不打断节奏；
 *  - medium 中等：成束火花 + 单层冲击波 + 金属“铛”声 + 轻微震屏；
 *  - heavy  猛撞：大量长拖尾火花 + 多层冲击波 + 低频重击声 + 明显震屏和方向性镜头冲击。
 * P2.2.1：取消 Hit-stop 和慢动作，时间始终正常流动；力度只靠真实物理结果和上面的视听反馈表现。
 */

export type ImpactTier = 'light' | 'medium' | 'heavy';

export const TIER_THRESHOLDS = { medium: 0.3, heavy: 0.65 };

export function impactTier(strength: number): ImpactTier {
  if (strength >= TIER_THRESHOLDS.heavy) return 'heavy';
  if (strength >= TIER_THRESHOLDS.medium) return 'medium';
  return 'light';
}

export interface ImpactFeedback {
  tier: ImpactTier;
  /** 0..1，等级内的相对力度 */
  local: number;
  /** 镜头震动量 0..1（相机内部再转成位移） */
  shake: number;
  /** 冲击推近 0..1 */
  fovKick: number;
  /** 火花数量（高画质下） */
  sparks: number;
  /** 火花速度倍率（喷射距离） */
  sparkSpeed: number;
  /** 火花寿命倍率（拖尾长度） */
  sparkLife: number;
  /** 闪光尺寸（世界单位） */
  flash: number;
  /** 点光源强度 */
  light: number;
  /** 冲击波层数 0..3 */
  waves: number;
  /** 手机振动毫秒 */
  vibrate: number;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export function impactFeedback(strength: number): ImpactFeedback {
  const s = clamp01(strength);
  const tier = impactTier(s);
  if (tier === 'light') {
    const k = s / TIER_THRESHOLDS.medium;
    return {
      tier,
      local: k,
      shake: lerp(0.04, 0.14, k),
      fovKick: 0,
      sparks: Math.round(lerp(5, 16, k)),
      sparkSpeed: lerp(0.45, 0.7, k),
      sparkLife: lerp(0.55, 0.75, k),
      flash: lerp(0.16, 0.26, k),
      light: lerp(2, 6, k),
      waves: 0,
      vibrate: 0,
    };
  }
  if (tier === 'medium') {
    const k = (s - TIER_THRESHOLDS.medium) / (TIER_THRESHOLDS.heavy - TIER_THRESHOLDS.medium);
    return {
      tier,
      local: k,
      shake: lerp(0.32, 0.5, k),
      fovKick: lerp(0.15, 0.35, k),
      sparks: Math.round(lerp(34, 60, k)),
      sparkSpeed: lerp(0.85, 1.1, k),
      sparkLife: lerp(0.9, 1.1, k),
      flash: lerp(0.4, 0.6, k),
      light: lerp(16, 30, k),
      waves: 1,
      vibrate: Math.round(lerp(12, 20, k)),
    };
  }
  const k = (s - TIER_THRESHOLDS.heavy) / (1 - TIER_THRESHOLDS.heavy);
  return {
    tier,
    local: k,
    shake: lerp(0.75, 1, k),
    fovKick: lerp(0.65, 1, k),
    sparks: Math.round(lerp(100, 150, k)),
    sparkSpeed: lerp(1.35, 1.75, k),
    sparkLife: lerp(1.3, 1.6, k),
    flash: lerp(0.8, 1.05, k),
    light: lerp(55, 80, k),
    waves: 2 + (k > 0.5 ? 1 : 0),
    vibrate: Math.round(lerp(32, 45, k)),
  };
}
