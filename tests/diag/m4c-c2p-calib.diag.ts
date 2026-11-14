/// <reference types="node" />
/**
 * M4-C · C2-P S3 撞后恢复探针的 Δp 标定（docs/engineering/m4c-c2-preregistration.md §6.1）：
 * 在 P0 上取 Δp = 3 rad/s 运行 S3（48 台）；峰值倾角 θ_v 的中位若在 [0.15, 0.40] rad 内则 Δp = 3；
 * 否则只允许在跑候选臂之前按比例调整一次：Δp = 3 × 0.275 / 中位（0.275 = 区间中点），记录后所有臂相同。
 * 输出 C2P-CALIB，并写 test-results/c2p-calib.json（实验臂读取）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'vitest';
import { loadRapier } from '../../src/game/physics/PhysicsWorld';
import { median } from './m4.metrics';
import { emit, runS3Suite, withArm } from './m4c-c2p.shared';

test('C2-P S3 Δp 标定（P0）', async () => {
  const R = await loadRapier();
  const DP0 = 3;
  const rows = withArm('P0', () => runS3Suite(R, 'S1', 'P0', DP0));
  const peaks = rows.filter((r) => r.reached).map((r) => r.peak as number);
  const med = median(peaks);
  const inRange = med >= 0.15 && med <= 0.4;
  const dp = inRange ? DP0 : (DP0 * 0.275) / med;
  const res = { dp0: DP0, n: rows.length, reached: peaks.length, medianPeak: med, inRange, adjusted: !inRange, dp, peaksByKey: Object.fromEntries(['lieren', 'pandun', 'senheng', 'ziyao'].map((k) => [k, median(rows.filter((r) => r.reached && r.key === k).map((r) => r.peak as number))])) };
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/c2p-calib.json', JSON.stringify(res));
  emit('c2p-calib.jsonl', 'C2P-CALIB', res);
  for (const r of rows) emit('c2p-calib.jsonl', 'C2P-CALIB-S3', r);
}, 3600000);
