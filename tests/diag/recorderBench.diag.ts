/**
 * Stage 0：诊断记录器自身开销的微基准（Node，无浏览器）。
 * 用法：npx vitest run --config vitest.diag.config.ts tests/diag/recorderBench.diag.ts
 * 输出每帧 skip + begin + end 的平均耗时（µs/frame），以及导出 60 秒（3600 帧）数据的耗时。
 */
import { test } from 'vitest';
import { PerfRecorder, type EnginePerfAcc } from '../../src/game/diag/PerfRecorder';

const ctx = {
  renderer: {
    info: { render: { calls: 40, triangles: 50000 }, memory: { geometries: 1, textures: 1 }, programs: [] },
    getPixelRatio: () => 3,
    shadowMap: { enabled: true },
    getContext: () => ({ drawingBufferWidth: 1, drawingBufferHeight: 1, SAMPLES: 0, getParameter: () => 4 }),
  } as never,
  quality: () => ({ level: 'high', locked: false }),
  shadowMapSize: () => 1536,
};
const acc = (): EnginePerfAcc => ({ tick: 0, render: 0, physics: 0, physSteps: 0, sync: 0, fx: 0, cam: 0, ui: 0 });

function bench(recording: boolean, frames: number): number {
  const r = new PerfRecorder();
  r.attach(ctx);
  const perf = acc();
  if (recording) r.start();
  const t0 = performance.now();
  for (let i = 0; i < frames; i++) {
    r.skip();
    r.begin(i * 16.7, 16.7, perf);
    perf.tick += 1;
    perf.physics += 0.5;
    r.end(perf, 'battle');
  }
  return ((performance.now() - t0) * 1000) / frames;
}

test('recorder overhead', () => {
  const FRAMES = 50000;
  bench(true, 5000);
  const idle = Math.min(bench(false, FRAMES), bench(false, FRAMES));
  const rec = Math.min(bench(true, FRAMES), bench(true, FRAMES));
  const r = new PerfRecorder();
  r.attach(ctx);
  r.start();
  const perf = acc();
  for (let i = 0; i < 3600; i++) {
    r.begin(i * 16.7, 16.7, perf);
    r.end(perf, 'battle');
  }
  r.stop();
  let t = performance.now();
  r.summary();
  const tSum = performance.now() - t;
  t = performance.now();
  const json = r.toJSON(true);
  const tJson = performance.now() - t;
  t = performance.now();
  const csv = r.toCSV();
  const tCsv = performance.now() - t;
  console.log(
    JSON.stringify({
      unit: 'µs/frame (Node, desktop CPU)',
      idleHooksPerFrameUs: idle,
      recordingHooksPerFrameUs: rec,
      export3600Frames: { summaryMs: tSum, jsonMs: tJson, jsonKB: json.length / 1024, csvMs: tCsv, csvKB: csv.length / 1024 },
    }),
  );
});
