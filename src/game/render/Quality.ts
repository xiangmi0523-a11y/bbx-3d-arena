/**
 * 画质分级与动态调整。
 *
 * 清晰度的关键是渲染分辨率要贴近屏幕物理像素（iPhone 是 3x Retina），
 * 但 3x + MSAA 的像素量对手机 GPU 压力很大、容易发热。
 * 这里按设备给一个起始档位，运行中持续评估“帧交付质量”（见 frameCadence.ts）：
 *  - 不再用固定的 50/58.5 fps 门槛。先估算系统当前给的刷新基准（60Hz、48Hz、120Hz 经 60 上限后的 60 等），
 *    再统计相对这个基准错过了多少次刷新机会（漏帧率）。稳定的 48Hz 漏帧率≈0，不会降档。
 *  - 漏帧率持续 2 秒高于 1/6 → 降一档；持续 6 秒低于 2.5% → 升一档（门槛依据见 AUTO_QUALITY）。
 * 帧率上限仍锁在 60（在 GameEngine 主循环里，ProMotion 120Hz 屏幕上也不多渲染），减少发热。
 */

import { DeliveryWindow, FrameCadenceEstimator } from './frameCadence';

export type QualityLevel = 'low' | 'medium' | 'high' | 'ultra';

export interface QualityPreset {
  level: QualityLevel;
  /** 像素比上限（实际取 min(devicePixelRatio, 该值)） */
  maxPixelRatio: number;
  /** 像素比下限：任何档位都不低于它（3x 屏上最低 2x，避免画面重新变糊） */
  minPixelRatio: number;
  shadowMapSize: number;
  shadows: boolean;
  sparkScale: number;
  /** 镜面反射环境贴图强度 */
  envIntensity: number;
}

/**
 * P2.1：清晰度优先。
 * 之前高档把 3x 屏渲染在 2.6x、中档 2x、低档 1.5x，浏览器再把画布非整数倍拉伸到屏幕，
 * 是“整体发糊”的主要原因。现在中/高/超三档都按设备原生像素比渲染（1:1 对应物理像素），
 * 性能不够时优先降阴影和粒子，只有最低档才降到 2x。
 */
export const PRESETS: Record<QualityLevel, QualityPreset> = {
  low: { level: 'low', maxPixelRatio: 2, minPixelRatio: 2, shadowMapSize: 1024, shadows: true, sparkScale: 0.45, envIntensity: 0.85 },
  medium: { level: 'medium', maxPixelRatio: 3, minPixelRatio: 2, shadowMapSize: 1024, shadows: true, sparkScale: 0.65, envIntensity: 1 },
  high: { level: 'high', maxPixelRatio: 3, minPixelRatio: 2, shadowMapSize: 1536, shadows: true, sparkScale: 0.9, envIntensity: 1 },
  ultra: { level: 'ultra', maxPixelRatio: 3, minPixelRatio: 2, shadowMapSize: 2048, shadows: true, sparkScale: 1, envIntensity: 1 },
};

const ORDER: QualityLevel[] = ['low', 'medium', 'high', 'ultra'];

export function initialQuality(ua: string, dpr: number, cores: number): QualityLevel {
  const mobile = /iPhone|iPad|iPod|Android/i.test(ua);
  if (!mobile) return dpr >= 2 ? 'high' : 'ultra';
  // 新款 iPhone（6 核以上 / 3x 屏）从 high 起步，旧机从 medium 起步
  if (/iPhone|iPad/.test(ua)) return cores >= 6 || dpr >= 3 ? 'high' : 'medium';
  return cores >= 8 ? 'medium' : 'low';
}

/**
 * 自动画质门槛。
 *
 * 漏帧率 = 错过的刷新机会 / 总刷新机会（相对当前刷新基准）。
 * - DOWN_MISS = 1/6：每 6 个刷新机会漏 1 个。在 60Hz 上正好等价于旧版“平均 < 50 fps 降档”，
 *   保留了 60Hz 设备上已经用过的灵敏度；同一比例在 48Hz 上对应 40 fps，而不是把 48 本身当成掉帧。
 *   测试里验证了：漏 1/8（12.5%）不降、漏 1/4（25%）降，48Hz 与 60Hz 结果一致。
 * - UP_MISS = 2.5%：在 60Hz 上等价于旧版“> 58.5 fps 才升档”。真机 48Hz 稳定段回放的漏帧率约 0–1%，
 *   低于此值，所以 48Hz 下也能正常升档。
 * - DOWN_HOLD_S / UP_HOLD_S：沿用旧版的 2 秒 / 6 秒防抖。
 * - UPGRADE_PROBATION_S：自动升档后 8 秒内冻结“更慢基准”的采纳，升档后节奏变慢一律算这次升档造成的
 *   （真机第 3 次记录里 high→ultra 后 6–13 秒出现了大量 30–37 ms 帧）。
 * - RETRY_HOLD_S：降过档之后，再次升档需要 30 秒稳定（而不是 6 秒），避免在临界档位来回切换。
 * - MAX_DOWNGRADES_FOR_UPGRADE：累计降档 2 次后不再自动升档（沿用旧版）。
 * - WARMUP_FRAMES：档位切换或后台恢复后窗口清空，攒够 30 帧才开始决策（沿用旧版 30 帧窗口）。
 *   切档那一下的着色器编译/阴影贴图重建长帧最多算 3 次漏帧（见 missedRefreshes），不足以单独触发降档。
 * - MAX_SAMPLE_S：超过 0.25 秒的单帧（切后台、生成缩略图等）不计入（沿用旧版），并触发一次热身。
 */
export const AUTO_QUALITY = {
  DOWN_MISS: 1 / 6,
  UP_MISS: 0.025,
  DOWN_HOLD_S: 2,
  UP_HOLD_S: 6,
  RETRY_HOLD_S: 30,
  UPGRADE_PROBATION_S: 8,
  MAX_DOWNGRADES_FOR_UPGRADE: 2,
  WARMUP_FRAMES: 30,
  MAX_SAMPLE_S: 0.25,
  DELIVERY_WINDOW: 60,
} as const;

export class QualityController {
  level: QualityLevel;
  /** 是否锁定（用户手动选择后不再自动调整） */
  locked = false;
  /** 刷新基准估算（跨档位保留：节奏是屏幕/系统的属性，不随画质变化） */
  readonly cadence = new FrameCadenceEstimator();
  private readonly window = new DeliveryWindow(AUTO_QUALITY.DELIVERY_WINDOW);
  private lowTime = 0;
  private goodTime = 0;
  private downgrades = 0;
  /** 自动切档次数（诊断/测试用） */
  changes = 0;
  onChange: ((preset: QualityPreset) => void) | null = null;

  constructor(level: QualityLevel) {
    this.level = level;
  }

  get preset(): QualityPreset {
    return PRESETS[this.level];
  }

  /** 当前漏帧率（相对刷新基准，0–1） */
  get missRatio(): number {
    return this.window.missRatio;
  }

  set(level: QualityLevel, lock = false): void {
    this.locked = lock;
    if (level === this.level) return;
    this.level = level;
    this.resetWindow();
    this.onChange?.(this.preset);
  }

  private resetWindow(): void {
    this.window.clear();
    this.lowTime = this.goodTime = 0;
  }

  /** 每帧调用，frameDt 为真实帧间隔（秒） */
  sample(frameDt: number): void {
    if (!(frameDt > 0)) return;
    if (frameDt > AUTO_QUALITY.MAX_SAMPLE_S) {
      // 后台恢复/超长单帧：不计入，并重新热身
      this.resetWindow();
      return;
    }
    const ms = frameDt * 1000;
    // 锁定时也更新刷新基准（不改档位），这样切回“自动”时基准是热的
    const rebased = this.cadence.push(ms);
    if (this.locked) {
      // 手动锁定：不做任何决策；窗口保持清空，切回“自动”后从热身重新开始
      if (this.window.n > 0) this.resetWindow();
      return;
    }
    const base = this.cadence.baseMs;
    if (rebased) {
      // 换了节奏：旧窗口是按被推翻的基准算的，按新基准重算，计时清零
      this.window.rebase(base);
      this.lowTime = this.goodTime = 0;
    }
    this.window.push(ms, base);
    if (this.window.n < AUTO_QUALITY.WARMUP_FRAMES) return;
    const miss = this.window.missRatio;
    if (miss > AUTO_QUALITY.DOWN_MISS) {
      this.lowTime += frameDt;
      this.goodTime = 0;
    } else if (miss < AUTO_QUALITY.UP_MISS) {
      this.goodTime += frameDt;
      this.lowTime = 0;
    } else {
      this.lowTime = Math.max(0, this.lowTime - frameDt);
    }
    const idx = ORDER.indexOf(this.level);
    const upHold = this.downgrades > 0 ? AUTO_QUALITY.RETRY_HOLD_S : AUTO_QUALITY.UP_HOLD_S;
    if (this.lowTime > AUTO_QUALITY.DOWN_HOLD_S && idx > 0) {
      this.downgrades++;
      this.changes++;
      // 观察期的结论已经给出（撤回了这次升档）；回到之前没问题的档位后若仍偏慢，就是系统节奏变了
      this.cadence.unfreeze();
      this.set(ORDER[idx - 1]);
    } else if (
      this.goodTime > upHold &&
      idx < ORDER.length - 1 &&
      this.downgrades < AUTO_QUALITY.MAX_DOWNGRADES_FOR_UPGRADE
    ) {
      this.changes++;
      this.set(ORDER[idx + 1]);
      this.cadence.freezeSlower(AUTO_QUALITY.UPGRADE_PROBATION_S);
    }
  }

  pixelRatio(dpr: number): number {
    const p = this.preset;
    return Math.max(Math.min(dpr, p.minPixelRatio), Math.min(dpr, p.maxPixelRatio));
  }
}
