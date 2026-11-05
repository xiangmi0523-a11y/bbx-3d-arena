/** 诊断统计的纯函数（单元测试覆盖）。所有时间单位均为毫秒（ms）。 */

/** 帧间隔直方图分桶上界（ms）。最后一桶为 > 100 ms。 */
export const HIST_EDGES_MS = [8.4, 12.5, 16.7, 18, 20, 25, 33.4, 50, 100] as const;

/** 长帧阈值：超过 33.4 ms（即低于 30 fps 的单帧） */
export const LONG_FRAME_MS = 33.4;
/** 满帧阈值：不超过 16.7 ms（60 fps 的一帧） */
export const FULL_FRAME_MS = 16.7;
/** 带 vsync 抖动容差的满帧阈值（辅助参考，不替代 16.7 ms 指标） */
export const FULL_FRAME_TOL_MS = 18;

/** 最近秩分位数（与游戏原有 PerfBadge 的取法一致：sorted[floor(n*q)]） */
export function quantile(sorted: ArrayLike<number>, q: number): number {
  const n = sorted.length;
  if (!n) return 0;
  return sorted[Math.min(n - 1, Math.floor(n * q))];
}

export interface Dist {
  /** 样本数 */
  n: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export function dist(values: ArrayLike<number>): Dist {
  const n = values.length;
  if (!n) return { n: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  const s = Float64Array.from(values as ArrayLike<number>).sort();
  let sum = 0;
  for (let i = 0; i < n; i++) sum += s[i];
  return { n, mean: sum / n, p50: quantile(s, 0.5), p95: quantile(s, 0.95), p99: quantile(s, 0.99), max: s[n - 1] };
}

export interface HistBin {
  /** 区间下界（不含），ms */
  fromMs: number;
  /** 区间上界（含），ms；最后一桶为 null（无上界） */
  toMs: number | null;
  count: number;
  /** 占全部帧的比例（0..1） */
  ratio: number;
}

export function histogram(values: ArrayLike<number>, edges: readonly number[] = HIST_EDGES_MS): HistBin[] {
  const counts = new Array(edges.length + 1).fill(0);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    let k = 0;
    while (k < edges.length && v > edges[k]) k++;
    counts[k]++;
  }
  const n = Math.max(1, values.length);
  return counts.map((count, k) => ({ fromMs: k === 0 ? 0 : edges[k - 1], toMs: k < edges.length ? edges[k] : null, count, ratio: count / n }));
}

export function ratioAtMost(values: ArrayLike<number>, limit: number): number {
  if (!values.length) return 0;
  let c = 0;
  for (let i = 0; i < values.length; i++) if (values[i] <= limit) c++;
  return c / values.length;
}

export interface LongFrameStats {
  /** 阈值（ms） */
  thresholdMs: number;
  /** 全部记录期间超过阈值的帧数 */
  total: number;
  /** 按记录时长折算的每 60 秒长帧数 */
  per60s: number;
  /** 记录开始后前 60 秒内的长帧数（记录不足 60 秒时为 null） */
  first60s: number | null;
  /** 任意连续 60 秒窗口内的最大长帧数（记录不足 60 秒时为 null） */
  worst60s: number | null;
}

/**
 * @param t 每帧的时间戳（ms，从记录开始算，单调递增）
 * @param interval 每帧的帧间隔（ms）
 * @param durationMs 记录总时长（ms）
 */
export function longFrames(t: ArrayLike<number>, interval: ArrayLike<number>, durationMs: number, threshold = LONG_FRAME_MS): LongFrameStats {
  const longT: number[] = [];
  for (let i = 0; i < interval.length; i++) if (interval[i] > threshold) longT.push(t[i]);
  const full = durationMs >= 60000;
  let first60s: number | null = null;
  let worst60s: number | null = null;
  if (full) {
    first60s = longT.filter((x) => x <= 60000).length;
    // 双指针：以每个长帧为窗口起点
    let best = 0;
    let j = 0;
    for (let i = 0; i < longT.length; i++) {
      while (j < longT.length && longT[j] - longT[i] < 60000) j++;
      best = Math.max(best, j - i);
    }
    worst60s = best;
  }
  return {
    thresholdMs: threshold,
    total: longT.length,
    per60s: durationMs > 0 ? (longT.length * 60000) / durationMs : 0,
    first60s,
    worst60s,
  };
}

/** 估计 performance.now() 的实际精度（ms）：iOS WebKit 会把计时器粗化到约 1 ms */
export function timerResolutionMs(now: () => number = () => performance.now()): number {
  let best = Infinity;
  for (let k = 0; k < 5; k++) {
    const a = now();
    let b = a;
    let guard = 0;
    while (b === a && guard++ < 1e6) b = now();
    if (b > a) best = Math.min(best, b - a);
  }
  return Number.isFinite(best) ? best : 0;
}
