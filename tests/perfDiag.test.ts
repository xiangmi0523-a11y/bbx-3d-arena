import { describe, expect, it } from 'vitest';
import { dist, histogram, longFrames, quantile, ratioAtMost } from '../src/game/diag/stats';
import { COLUMNS, PerfRecorder, type EnginePerfAcc } from '../src/game/diag/PerfRecorder';

describe('Stage 0 诊断统计', () => {
  it('分位数与原 PerfBadge 取法一致（sorted[floor(n*q)]）', () => {
    const s = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(quantile(s, 0.5)).toBe(51);
    expect(quantile(s, 0.95)).toBe(96);
    expect(quantile(s, 0.99)).toBe(100);
    const d = dist([3, 1, 2]);
    expect(d).toMatchObject({ n: 3, mean: 2, p50: 2, max: 3 });
  });

  it('直方图分桶覆盖所有帧，边界值落在上界所在桶', () => {
    const v = [8, 16.7, 16.8, 33.4, 33.5, 120];
    const h = histogram(v);
    expect(h.reduce((a, b) => a + b.count, 0)).toBe(v.length);
    expect(h.find((b) => b.toMs === 16.7)!.count).toBe(1);
    expect(h.find((b) => b.toMs === 33.4)!.count).toBe(1);
    expect(h[h.length - 1]).toMatchObject({ toMs: null, count: 1 });
    expect(ratioAtMost(v, 16.7)).toBeCloseTo(2 / 6);
  });

  it('长帧：总数、每 60 秒折算、前 60 秒、最差 60 秒窗口', () => {
    // 120 秒，每帧 16.7 ms；在 10 s、20 s、70 s、71 s、72 s 处各有一个 40 ms 长帧
    const t: number[] = [];
    const iv: number[] = [];
    let now = 0;
    const longAt = new Set([10000, 20000, 70000, 71000, 72000]);
    while (now < 120000) {
      const isLong = [...longAt].some((x) => now <= x && now + 16.7 > x);
      const dt = isLong ? 40 : 16.7;
      now += dt;
      t.push(now);
      iv.push(dt);
    }
    const lf = longFrames(t, iv, now);
    expect(lf.total).toBe(5);
    expect(lf.first60s).toBe(2);
    expect(lf.worst60s).toBe(4); // 20 s..72 s 窗口
    expect(lf.per60s).toBeCloseTo((5 * 60000) / now);
    expect(longFrames(t.slice(0, 100), iv.slice(0, 100), 1670).first60s).toBeNull();
  });
});

describe('Stage 0 逐帧记录器', () => {
  const fakeCtx = () => ({
    renderer: {
      info: { render: { calls: 42, triangles: 30000 }, memory: { geometries: 1, textures: 2 }, programs: [] },
      getPixelRatio: () => 3,
      shadowMap: { enabled: true },
      getContext: () => ({ drawingBufferWidth: 2532, drawingBufferHeight: 1170, SAMPLES: 0, getParameter: () => 4 }),
    } as never,
    quality: () => ({ level: 'high', locked: false }),
    shadowMapSize: () => 1536,
  });

  it('从引擎累加器差分出每帧分段，导出 JSON / CSV 带单位与构建 SHA', () => {
    const r = new PerfRecorder();
    r.attach(fakeCtx());
    const perf: EnginePerfAcc = { tick: 0, render: 0, physics: 0, physSteps: 0, sync: 0, fx: 0, cam: 0, ui: 0 };
    r.start();
    let now = 1000;
    for (let i = 0; i < 10; i++) {
      r.skip();
      now += 16.7;
      r.begin(now, 16.7, perf);
      perf.physics += 2;
      perf.physSteps += 2;
      perf.sync += 0.5;
      perf.fx += 0.25;
      perf.cam += 0.25;
      perf.ui += 0.1;
      perf.tick += 3.5;
      perf.render += 4;
      r.end(perf, 'battle');
    }
    r.stop();
    const s = r.summary();
    expect(s.recording.samples).toBe(10);
    expect(s.all.frames).toBe(9); // 首帧没有帧间隔
    expect(s.battleOnly.frames).toBe(9);
    expect(s.all.cpu.physics.mean).toBeCloseTo(2);
    expect(s.all.cpu.physStepsPerFrame.mean).toBeCloseTo(2);
    expect(s.all.cpu.tickOther.mean).toBeCloseTo(0.4);
    expect(s.all.cpu.renderSubmit.mean).toBeCloseTo(4);
    expect(s.all.render.drawCalls.mean).toBe(42);
    expect(s.all.render.pixelRatios).toEqual([3]);
    expect(s.renderState).toMatchObject({ shadowsEnabled: true, shadowMapSizePx: 1536, quality: 'high', qualityMode: 'auto' });
    expect(s.events.some((e) => e.type === 'phase' && e.value === 'battle')).toBe(true);
    expect(s.units.time).toBe('ms');
    const json = JSON.parse(r.toJSON(true));
    expect(json.frames.columns).toEqual(COLUMNS.map(([k]) => k));
    expect(json.frames.rows).toHaveLength(10);
    expect(json.build.sha).toBeTypeOf('string');
    const csv = r.toCSV().split('\n');
    expect(csv[0]).toMatch(/^# build=/);
    expect(csv[2]).toBe(COLUMNS.map(([k]) => k).join(','));
    expect(csv).toHaveLength(3 + 10);
    expect(r.summaryCSV()).toContain('battleOnly,intervalP95,16.7,ms');
  });

  it('未开始记录时所有钩子都是空操作', () => {
    const r = new PerfRecorder();
    const perf: EnginePerfAcc = { tick: 0, render: 0, physics: 0, physSteps: 0, sync: 0, fx: 0, cam: 0, ui: 0 };
    r.skip();
    r.begin(1, 16, perf);
    r.end(perf, 'battle');
    expect(r.frames).toBe(0);
  });

  it('自动停止在设定时长后触发', () => {
    const r = new PerfRecorder();
    r.attach(fakeCtx());
    const perf: EnginePerfAcc = { tick: 0, render: 0, physics: 0, physSteps: 0, sync: 0, fx: 0, cam: 0, ui: 0 };
    let stopped = 0;
    r.onAutoStop = () => stopped++;
    r.start(1);
    const t0 = performance.now();
    for (let i = 0; i < 200 && r.recording; i++) {
      r.begin(t0 + i * 16.7, 16.7, perf);
      r.end(perf, 'battle');
    }
    expect(stopped).toBe(1);
    expect(r.frames).toBeLessThan(70);
  });
});
