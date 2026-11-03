/**
 * 画质分级与动态调整。
 *
 * 清晰度的关键是渲染分辨率要贴近屏幕物理像素（iPhone 是 3x Retina），
 * 但 3x + MSAA 的像素量对手机 GPU 压力很大、容易发热。
 * 这里按设备给一个起始档位，运行中持续测帧时间：
 *  - 连续 2 秒低于 50fps → 降一档（先降分辨率，再降阴影和粒子）；
 *  - 连续 6 秒稳定 59fps 以上且之前没因发热降过两次 → 升一档。
 * 同时把帧率上限锁在 60（ProMotion 120Hz 屏幕上也不多渲染），减少发热。
 */

export type QualityLevel = 'low' | 'medium' | 'high' | 'ultra';

export interface QualityPreset {
  level: QualityLevel;
  /** 像素比上限（实际取 min(devicePixelRatio, 该值)） */
  maxPixelRatio: number;
  shadowMapSize: number;
  shadows: boolean;
  sparkScale: number;
  /** 镜面反射环境贴图强度 */
  envIntensity: number;
}

export const PRESETS: Record<QualityLevel, QualityPreset> = {
  low: { level: 'low', maxPixelRatio: 1.5, shadowMapSize: 1024, shadows: true, sparkScale: 0.55, envIntensity: 0.8 },
  medium: { level: 'medium', maxPixelRatio: 2, shadowMapSize: 1024, shadows: true, sparkScale: 0.8, envIntensity: 1 },
  high: { level: 'high', maxPixelRatio: 2.6, shadowMapSize: 2048, shadows: true, sparkScale: 1, envIntensity: 1 },
  ultra: { level: 'ultra', maxPixelRatio: 3, shadowMapSize: 2048, shadows: true, sparkScale: 1, envIntensity: 1 },
};

const ORDER: QualityLevel[] = ['low', 'medium', 'high', 'ultra'];

export function initialQuality(ua: string, dpr: number, cores: number): QualityLevel {
  const mobile = /iPhone|iPad|iPod|Android/i.test(ua);
  if (!mobile) return dpr >= 2 ? 'high' : 'ultra';
  // 新款 iPhone（6 核以上 / 3x 屏）从 high 起步，旧机从 medium 起步
  if (/iPhone|iPad/.test(ua)) return cores >= 6 || dpr >= 3 ? 'high' : 'medium';
  return cores >= 8 ? 'medium' : 'low';
}

export class QualityController {
  level: QualityLevel;
  /** 是否锁定（用户手动选择后不再自动调整） */
  locked = false;
  private samples: number[] = [];
  private lowTime = 0;
  private goodTime = 0;
  private downgrades = 0;
  onChange: ((preset: QualityPreset) => void) | null = null;

  constructor(level: QualityLevel) {
    this.level = level;
  }

  get preset(): QualityPreset {
    return PRESETS[this.level];
  }

  set(level: QualityLevel, lock = false): void {
    this.locked = lock;
    if (level === this.level) return;
    this.level = level;
    this.samples = [];
    this.lowTime = this.goodTime = 0;
    this.onChange?.(this.preset);
  }

  /** 每帧调用，frameDt 为真实帧间隔（秒） */
  sample(frameDt: number): void {
    if (this.locked || frameDt <= 0 || frameDt > 0.5) return;
    this.samples.push(frameDt);
    if (this.samples.length > 30) this.samples.shift();
    if (this.samples.length < 30) return;
    const avg = this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
    const fps = 1 / avg;
    if (fps < 50) {
      this.lowTime += frameDt;
      this.goodTime = 0;
    } else if (fps > 58.5) {
      this.goodTime += frameDt;
      this.lowTime = 0;
    } else {
      this.lowTime = Math.max(0, this.lowTime - frameDt);
    }
    const idx = ORDER.indexOf(this.level);
    if (this.lowTime > 2 && idx > 0) {
      this.downgrades++;
      this.set(ORDER[idx - 1]);
    } else if (this.goodTime > 6 && idx < ORDER.length - 1 && this.downgrades < 2) {
      this.set(ORDER[idx + 1]);
    }
  }

  pixelRatio(dpr: number): number {
    return Math.min(dpr, this.preset.maxPixelRatio);
  }
}
