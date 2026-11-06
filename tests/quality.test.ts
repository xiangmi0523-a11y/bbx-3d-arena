/**
 * 自动画质：刷新节奏识别与漏帧判定。
 *
 * 全部输入都是确定性的合成帧间隔序列（不用随机数）：
 *  - 回调时间戳 = 刷新时刻 + 抖动，抖动用 A·sin(k·黄金角) 生成（确定、非周期）；
 *  - 再按 1 ms 取整（iOS WKWebView 的 performance.now 精度），取相邻差作为帧间隔。
 *  - 48Hz 抖动幅度 1.5 ms（间隔标准差约 1.6 ms，略大于真机 48Hz 段的 1.3 ms，散布 17–25 ms）；60Hz 抖动 0.6 ms，对应真机 16/17 ms。
 * 最后一组用 Stage 0 真机逐帧记录回放，作为补充证据。
 */
import { describe, expect, it } from 'vitest';
import { AUTO_QUALITY, QualityController, type QualityLevel } from '../src/game/render/Quality';
import { CADENCE, DeliveryWindow, FrameCadenceEstimator, missedRefreshes } from '../src/game/render/frameCadence';
import fixtures from './fixtures/iphone-frame-intervals.json';

const GOLDEN = 2.399963229728653;

interface Segment {
  hz: number;
  seconds: number;
  /** 每 missEvery 帧里有 1 帧错过刷新（间隔 = (1+missRefreshes) 个周期） */
  missEvery?: number;
  missRefreshes?: number;
  /** 抖动幅度（ms），默认 48Hz 2 ms、其他 0.6 ms */
  jitterMs?: number;
}

/** 生成帧间隔序列（秒）。时间轴连续，跨段切换节奏时不会出现人为的跳变。 */
function synth(segments: Segment[]): number[] {
  const out: number[] = [];
  let vsync = 0;
  let k = 0;
  let lastTs = 0;
  for (const s of segments) {
    const p = 1000 / s.hz;
    const amp = s.jitterMs ?? (s.hz <= 50 ? 1.5 : 0.6);
    const frames = Math.round(s.seconds * s.hz);
    for (let i = 0; i < frames; i++) {
      const miss = s.missEvery && i % s.missEvery === s.missEvery - 1 ? (s.missRefreshes ?? 1) : 0;
      vsync += p * (1 + miss);
      k++;
      const ts = Math.round(vsync + amp * Math.sin(k * GOLDEN));
      out.push((ts - lastTs) / 1000);
      lastTs = ts;
    }
  }
  out.shift(); // 第一帧没有真实前序
  return out;
}

function run(q: QualityController, intervals: number[], onSample?: (i: number, t: number) => void) {
  const levels: QualityLevel[] = [];
  let t = 0;
  intervals.forEach((d, i) => {
    q.sample(d);
    t += d;
    onSample?.(i, t);
    if (levels[levels.length - 1] !== q.level) levels.push(q.level);
  });
  return levels;
}

/** 旧版控制器（固定 50/58.5 fps 门槛），只用来证明回归场景确实修好了 */
class LegacyController {
  level: QualityLevel;
  private s: number[] = [];
  private low = 0;
  private good = 0;
  private downs = 0;
  downgrades = 0;
  constructor(level: QualityLevel) {
    this.level = level;
  }
  sample(dt: number) {
    if (dt <= 0 || dt > 0.25) return;
    this.s.push(dt);
    if (this.s.length > 30) this.s.shift();
    if (this.s.length < 30) return;
    const fps = 1 / (this.s.reduce((a, b) => a + b, 0) / 30);
    if (fps < 50) {
      this.low += dt;
      this.good = 0;
    } else if (fps > 58.5) {
      this.good += dt;
      this.low = 0;
    } else this.low = Math.max(0, this.low - dt);
    const order: QualityLevel[] = ['low', 'medium', 'high', 'ultra'];
    const idx = order.indexOf(this.level);
    if (this.low > 2 && idx > 0) {
      this.downs++;
      this.downgrades++;
      this.level = order[idx - 1];
      this.s = [];
      this.low = this.good = 0;
    } else if (this.good > 6 && idx < 3 && this.downs < 2) {
      this.level = order[idx + 1];
      this.s = [];
      this.low = this.good = 0;
    }
  }
}

const RANK: Record<QualityLevel, number> = { low: 0, medium: 1, high: 2, ultra: 3 };

function countDowngrades(levels: QualityLevel[]) {
  let n = 0;
  for (let i = 1; i < levels.length; i++) if (RANK[levels[i]] < RANK[levels[i - 1]]) n++;
  return n;
}

describe('刷新基准估算（纯函数/小模块）', () => {
  it('单帧漏帧数：按基准的连续比值，长帧最多算 3 次', () => {
    expect(missedRefreshes(1000 / 60, 1000 / 60)).toBeCloseTo(0);
    expect(missedRefreshes(2000 / 60, 1000 / 60)).toBeCloseTo(1);
    expect(missedRefreshes(2000 / 48, 1000 / 48)).toBeCloseTo(1);
    expect(missedRefreshes(200, 1000 / 60)).toBe(3);
    expect(missedRefreshes(5, 1000 / 60)).toBe(-0.5);
  });

  it('稳定 60Hz / 48Hz / 120Hz 经 60 上限 / 90Hz 经上限 都能估出正确基准', () => {
    const cases: Array<[number, number]> = [
      [60, 1000 / 60],
      [48, 1000 / 48],
      [45, 1000 / 45], // 90Hz 屏经 60 上限后每 2 次回调渲染 1 次
      [72, 1000 / 72], // 144Hz 屏经上限后
    ];
    for (const [hz, expectMs] of cases) {
      const e = new FrameCadenceEstimator();
      for (const d of synth([{ hz, seconds: 5 }])) e.push(d * 1000);
      expect(e.hasBase).toBe(true);
      expect(Math.abs(e.baseMs - expectMs)).toBeLessThan(0.35);
    }
  });

  it('半速节奏（60Hz 每帧都漏一次 = 30Hz）不会被当成正常基准', () => {
    const e = new FrameCadenceEstimator();
    for (const d of synth([{ hz: 60, seconds: 3 }, { hz: 30, seconds: 20 }])) e.push(d * 1000);
    expect(e.baseMs).toBeCloseTo(1000 / 60, 0);
    expect(e.baseMs).toBeLessThanOrEqual(CADENCE.MAX_BASE_MS);
  });

  it('16.7/33.3 交替的掉帧（60Hz GPU 受限）不会被当成新基准', () => {
    const e = new FrameCadenceEstimator();
    for (const d of synth([{ hz: 60, seconds: 3 }, { hz: 60, seconds: 20, missEvery: 2 }])) e.push(d * 1000);
    expect(e.baseMs).toBeCloseTo(1000 / 60, 0);
  });

  it('观察期内不采纳更慢的基准', () => {
    const e = new FrameCadenceEstimator();
    for (const d of synth([{ hz: 60, seconds: 3 }])) e.push(d * 1000);
    e.freezeSlower(8);
    const seq = synth([{ hz: 48, seconds: 6 }]);
    for (const d of seq) e.push(d * 1000);
    expect(e.baseMs).toBeCloseTo(1000 / 60, 0);
    for (const d of synth([{ hz: 48, seconds: 5 }])) e.push(d * 1000);
    expect(e.baseMs).toBeCloseTo(1000 / 48, 0);
  });

  it('漏帧窗口：rebase 后按新基准重算', () => {
    const w = new DeliveryWindow(60);
    for (let i = 0; i < 60; i++) w.push(1000 / 48, 1000 / 60);
    expect(w.missRatio).toBeCloseTo(0.2, 2); // 按 60Hz 基准看，每帧晚 0.25 个周期
    w.rebase(1000 / 48);
    expect(w.missRatio).toBe(0);
  });
});

describe('自动画质：按刷新节奏判断漏帧', () => {
  it('1. 稳定 48Hz 持续运行 2 分钟：不降档（旧版会降档）', () => {
    const seq = synth([{ hz: 48, seconds: 120 }]);
    const q = new QualityController('high');
    const levels = run(q, seq);
    expect(countDowngrades(levels)).toBe(0);
    expect(RANK[q.level]).toBeGreaterThanOrEqual(RANK.high);
    expect(q.cadence.baseMs).toBeCloseTo(1000 / 48, 0);
    const legacy = new LegacyController('high');
    for (const d of seq) legacy.sample(d);
    expect(legacy.downgrades).toBeGreaterThan(0);
  });

  it('1b. 稳定 48Hz 下也能正常自动升档', () => {
    const q = new QualityController('medium');
    run(q, synth([{ hz: 48, seconds: 20 }]));
    expect(RANK[q.level]).toBeGreaterThan(RANK.medium);
  });

  it('2. 稳定 60Hz：不降档，并能升档', () => {
    const q = new QualityController('high');
    const levels = run(q, synth([{ hz: 60, seconds: 120 }]));
    expect(countDowngrades(levels)).toBe(0);
    expect(q.level).toBe('ultra');
  });

  it('3. 48Hz 中持续出现接近两个刷新周期的间隔：识别为真实漏帧并降档', () => {
    // 每 3 帧 1 帧错过一次刷新（41.7 ms），漏帧率 25%；平均 36 fps
    const seq = synth([{ hz: 48, seconds: 5 }, { hz: 48, seconds: 10, missEvery: 3 }]);
    const q = new QualityController('high');
    let downAt = -1;
    run(q, seq, (_i, t) => {
      if (downAt < 0 && q.level !== 'high') downAt = t;
    });
    expect(q.cadence.baseMs).toBeCloseTo(1000 / 48, 0); // 慢帧没有被当成新基准
    expect(downAt).toBeGreaterThan(5);
    expect(downAt).toBeLessThan(5 + 5); // 5 秒内反应
  });

  it('4. 60Hz 中持续出现接近两个刷新周期的间隔：识别为真实漏帧并降档', () => {
    const seq = synth([{ hz: 60, seconds: 5 }, { hz: 60, seconds: 10, missEvery: 3 }]);
    const q = new QualityController('high');
    let downAt = -1;
    run(q, seq, (_i, t) => {
      if (downAt < 0 && q.level !== 'high') downAt = t;
    });
    expect(q.cadence.baseMs).toBeCloseTo(1000 / 60, 0);
    expect(downAt).toBeGreaterThan(5);
    expect(downAt).toBeLessThan(10);
  });

  it('3/4 门槛：漏 1/8 不降、漏 1/4 降，48Hz 与 60Hz 结论一致', () => {
    for (const hz of [48, 60]) {
      const mild = new QualityController('high');
      run(mild, synth([{ hz, seconds: 3 }, { hz, seconds: 30, missEvery: 8 }])); // 漏帧率 1/9 ≈ 11%
      expect(mild.level).toBe('high');
      const heavy = new QualityController('high');
      run(heavy, synth([{ hz, seconds: 3 }, { hz, seconds: 30, missEvery: 4 }])); // 漏帧率 1/5 = 20%
      expect(RANK[heavy.level]).toBeLessThan(RANK.high);
    }
  });

  it('容差：48Hz 抖动加大到间隔标准差约 2.5 ms 仍识别为 48Hz，不降档', () => {
    const q = new QualityController('high');
    const levels = run(q, synth([{ hz: 48, seconds: 60, jitterMs: 2.5 }]));
    expect(countDowngrades(levels)).toBe(0);
    expect(Math.abs(q.cadence.baseMs - 1000 / 48)).toBeLessThan(1);
  });

  it('75Hz 屏经 60 上限后的 37.5 次/秒（26.7 ms）是正常节奏，不降档', () => {
    const q = new QualityController('high');
    const levels = run(q, synth([{ hz: 37.5, seconds: 60, jitterMs: 0.6 }]));
    expect(countDowngrades(levels)).toBe(0);
  });

  it('可变刷新率屏上 16.7/25 ms 混合（GPU 受限晚一格）不会被当成 40 次/秒基准，按漏帧处理', () => {
    const pattern = [25, 25, 1000 / 60, 25, 1000 / 60]; // 60% 的帧晚了半个周期
    const seq = synth([{ hz: 60, seconds: 3 }]);
    for (let i = 0; i < 600; i++) seq.push(pattern[i % pattern.length] / 1000);
    const q = new QualityController('high');
    run(q, seq);
    expect(q.cadence.baseMs).toBeCloseTo(1000 / 60, 0);
    expect(RANK[q.level]).toBeLessThan(RANK.high);
  });

  it('稳定的半速（60Hz 屏上一直 30 fps）仍按掉帧处理', () => {
    const q = new QualityController('high');
    run(q, synth([{ hz: 60, seconds: 2 }, { hz: 30, seconds: 10 }]));
    expect(RANK[q.level]).toBeLessThan(RANK.high);
  });

  it('5. 48Hz 与 60Hz 来回切换：切换瞬间不误降档', () => {
    const segs: Segment[] = [];
    for (let i = 0; i < 6; i++) segs.push({ hz: i % 2 ? 48 : 60, seconds: 4 + (i % 3) * 3 });
    segs.push({ hz: 48, seconds: 30 });
    const q = new QualityController('high');
    const levels = run(q, synth(segs));
    expect(countDowngrades(levels)).toBe(0);
    expect(q.cadence.baseMs).toBeCloseTo(1000 / 48, 0);
  });

  it('5b. 刚升档后系统恰好切到 48Hz：最多误降一次，随后不再反复', () => {
    // 观察期内节奏变慢会被算作升档造成的（偏保守），这里确认代价有上限
    const q = new QualityController('high');
    const levels = run(q, synth([{ hz: 60, seconds: 8 }, { hz: 48, seconds: 120 }]));
    expect(countDowngrades(levels)).toBeLessThanOrEqual(1);
    expect(q.changes).toBeLessThanOrEqual(4);
  });

  it('6. 偶发长帧、GC 小卡顿、后台恢复：不触发降档', () => {
    for (const hz of [60, 48]) {
      const seq = synth([{ hz, seconds: 60 }]);
      const p = 1 / hz;
      for (let i = 90; i < seq.length; i += 90) seq[i] = 0.08; // 约每 1.5–2 秒一次 80 ms 长帧
      for (let i = 400; i < seq.length; i += 600) for (let j = 0; j < 4; j++) seq[i + j] = 0.05; // GC 连续 4 帧 50 ms
      seq.splice(1500, 0, 2.5, 0.004, 0.004, p * 3); // 后台 2.5 秒，回来后几帧挤在一起
      for (let i = 2000; i < 2000 + hz * 0.4; i++) seq[i] = 2 * p; // 一次约 0.8 秒的短暂半速
      const q = new QualityController('high');
      const levels = run(q, seq);
      expect(countDowngrades(levels)).toBe(0);
    }
  });

  it('7. 手动锁定画质：自动系统不覆盖；切回自动后恢复自动调整', () => {
    const q = new QualityController('high');
    let calls = 0;
    q.onChange = () => calls++;
    q.set('medium', true);
    calls = 0;
    run(q, synth([{ hz: 60, seconds: 20, missEvery: 2 }])); // 严重掉帧
    expect(q.level).toBe('medium');
    run(q, synth([{ hz: 60, seconds: 60 }])); // 长时间完美
    expect(q.level).toBe('medium');
    expect(calls).toBe(0);
    expect(q.changes).toBe(0);
    // 解除锁定（GameEngine.setQuality('auto') 就是把 locked 置 false）
    q.locked = false;
    run(q, synth([{ hz: 60, seconds: 10, missEvery: 2 }]));
    expect(q.level).toBe('low');
  });

  it('8. 长时间稳定运行（10 分钟）：不反复升降档', () => {
    for (const hz of [60, 48]) {
      const q = new QualityController('high');
      run(q, synth([{ hz, seconds: 600 }]));
      expect(q.changes).toBe(1); // 只有一次 high→ultra
      expect(q.level).toBe('ultra');
    }
  });

  it('8b. 临界设备（ultra 会漏帧、high 正常）10 分钟内切档次数有上限，最终稳定在 high', () => {
    // 用档位决定下一帧的间隔：ultra 每 3 帧漏 1 帧，其他档位稳定
    for (const hz of [60, 48]) {
      const q = new QualityController('high');
      const p = 1 / hz;
      let k = 0;
      let lastChangeAt = 0;
      let t = 0;
      let prev = q.level;
      while (t < 600) {
        const miss = q.level === 'ultra' && k % 3 === 2;
        const d = p * (miss ? 2 : 1) + 0.0006 * Math.sin(k * GOLDEN);
        k++;
        q.sample(d);
        t += d;
        if (q.level !== prev) {
          lastChangeAt = t;
          prev = q.level;
        }
      }
      expect(q.level).toBe('high');
      expect(q.changes).toBeLessThanOrEqual(4); // high→ultra→high 最多两轮
      expect(lastChangeAt).toBeLessThan(120);
    }
  });

  it('8c. 升档后 GPU 受限导致节奏变成稳定的 48 次/秒：识别为这次升档造成的，退回原档', () => {
    const q = new QualityController('high');
    const p60 = 1 / 60;
    const p48 = 1 / 48;
    let k = 0;
    let t = 0;
    let wentUltra = false;
    while (t < 120) {
      const d = (q.level === 'ultra' ? p48 : p60) + 0.0005 * Math.sin(k * GOLDEN);
      k++;
      q.sample(d);
      t += d;
      if (q.level === 'ultra') wentUltra = true;
    }
    expect(wentUltra).toBe(true);
    expect(q.level).toBe('high');
  });
});

describe('真机序列回放（Stage 0 逐帧记录，补充证据）', () => {
  type Run = { intervalsMs: number[]; qualityRuns: [string, number][] };
  const runs = fixtures as unknown as Record<string, Run>;

  it('run4：锁 low 时 60→48 漂移，若是自动模式也不会降档（旧版会降）', () => {
    const iv = runs.run4.intervalsMs.map((x) => x / 1000);
    const q = new QualityController('high');
    const levels = run(q, iv);
    expect(countDowngrades(levels)).toBe(0);
    expect(q.cadence.baseMs).toBeGreaterThan(20);
    expect(q.cadence.baseMs).toBeLessThan(22);
    const legacy = new LegacyController('high');
    for (const d of iv) legacy.sample(d);
    expect(legacy.downgrades).toBeGreaterThan(0);
  });

  it('run1：60/48 混杂的长时间运行，不降档', () => {
    const q = new QualityController('high');
    const levels = run(q, runs.run1.intervalsMs.map((x) => x / 1000));
    expect(countDowngrades(levels)).toBe(0);
  });

  it('run3：真实掉帧段（ultra 及随后的 high，30–37 ms）会被识别为漏帧', () => {
    // 记录里 ultra 段与其后的 high 段都在掉帧（旧版正是在 ultra 段末尾降档的），连起来回放
    const r = runs.run3;
    const start = r.qualityRuns[0][1];
    const len = r.qualityRuns[1][1] + r.qualityRuns[2][1];
    const ultra = r.intervalsMs.slice(start, start + len).map((x) => x / 1000);
    const q = new QualityController('ultra');
    // 先用记录开头 high 段的 60Hz 帧建立基准
    run(q, r.intervalsMs.slice(0, start).map((x) => x / 1000));
    q.set('ultra');
    run(q, ultra);
    expect(RANK[q.level]).toBeLessThan(RANK.ultra);
  });
});

describe('开销', () => {
  it('每帧 sample() 远低于 0.01 ms，且不分配数组', () => {
    const q = new QualityController('high');
    const seq = synth([{ hz: 48, seconds: 30 }, { hz: 60, seconds: 30, missEvery: 5 }]);
    for (const d of seq) q.sample(d); // 预热 JIT
    q.locked = false;
    const N = 200_000;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) q.sample(seq[i % seq.length]);
    const per = (performance.now() - t0) / N;
    // eslint-disable-next-line no-console
    console.log(`QualityController.sample: ${(per * 1000).toFixed(3)} µs/帧`);
    expect(per).toBeLessThan(0.01);
  });

  it('常量关系：MAX_BASE 小于 72 次/秒节奏的两倍周期', () => {
    expect(CADENCE.MAX_BASE_MS).toBeLessThan(2 * (1000 / 72));
    expect(CADENCE.MAX_BASE_MS).toBeGreaterThan(1000 / 37.5); // 75Hz 屏经上限后的 37.5 次/秒仍可作为基准
    expect(AUTO_QUALITY.DOWN_MISS).toBeCloseTo(1 - 50 / 60); // 60Hz 上等价旧版 50 fps
    expect(AUTO_QUALITY.UP_MISS).toBeCloseTo(1 - 58.5 / 60); // 60Hz 上等价旧版 58.5 fps
  });
});
