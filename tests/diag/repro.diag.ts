/**
 * 180 个固定种子场景的完整记录（阶段 1 可重复测试基线）。
 *   npx vitest run --config vitest.diag.config.ts tests/diag/repro.diag.ts
 * 环境变量：
 *   REPRO_OUT=文件            输出路径（默认 test-results/repro/run.json）
 *   REPRO_ORDER=reverse       逆序运行（检查场景之间是否互相影响）
 *   REPRO_ONLY=名1,名2        只跑指定场景；REPRO_GROUPS=AvD,NNPOW 只跑指定分组
 *   REPRO_DETAIL=起-止        在 [起, 止) 步逐步展开完整状态（配合 REPRO_ONLY 定位差异）
 *   REPRO_NO_KEYFRAMES=1      不写关键帧（文件更小）
 *   REPRO_GOLDEN_WRITE=文件   同时写出每场摘要（tests/fixtures/repro-golden.json 由它生成）
 *   REPRO_TUNE='{"键":值}'   临时覆盖 BEY_TUNING（只在本进程内，用于验证对照工具能发现并定位变化）
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { test } from 'vitest';
import { summarize } from '../repro/compare';
import { configFingerprint, configSnapshot } from '../repro/config';
import { rapier, recordRun, type Trace } from '../repro/recorder';
import { BEY_TUNING } from '../../src/game/beys/BeyPhysics';
import { scenariosV2 } from './stallprobe2.shared';

if (process.env.REPRO_TUNE) Object.assign(BEY_TUNING, JSON.parse(process.env.REPRO_TUNE));

test('repro: 180 场固定种子记录', async () => {
  const R = await rapier();
  const env = process.env;
  const out = env.REPRO_OUT ?? 'test-results/repro/run.json';
  const only = env.REPRO_ONLY?.split(',') ?? null;
  const groups = env.REPRO_GROUPS?.split(',') ?? null;
  const detail = env.REPRO_DETAIL ? (env.REPRO_DETAIL.split('-').map(Number) as [number, number]) : undefined;
  let list = scenariosV2().filter((s) => (!only || only.includes(s.name)) && (!groups || groups.includes(s.group)));
  if (env.REPRO_ORDER === 'reverse') list = list.reverse();
  const git = (c: string) => {
    try {
      return execSync(c).toString().trim();
    } catch {
      return '';
    }
  };
  const t0 = performance.now();
  const runs: Trace[] = [];
  for (const sc of list) runs.push(recordRun(R, sc, { keyframes: !env.REPRO_NO_KEYFRAMES, detail }));
  const ms = Math.round(performance.now() - t0);
  mkdirSync(dirname(out), { recursive: true });
  const meta = {
    head: git('git rev-parse HEAD'),
    dirty: git('git status --porcelain'),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    order: env.REPRO_ORDER ?? 'forward',
    tune: env.REPRO_TUNE ?? null,
    ms,
    config: configFingerprint(R),
    configSnapshot: configSnapshot(R),
  };
  writeFileSync(out, JSON.stringify({ ...meta, runs }));
  if (env.REPRO_GOLDEN_WRITE) {
    const byName = [...runs].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    writeFileSync(env.REPRO_GOLDEN_WRITE, JSON.stringify({ generatedFrom: meta.head, config: meta.config, runs: byName.map(summarize) }, null, 1) + '\n');
  }
  const bypass = runs.filter((r) => r.random.run.bypass.performanceNow + r.random.run.bypass.dateNow + r.random.run.bypass.cryptoRandom + r.random.setup.bypass.performanceNow + r.random.setup.bypass.dateNow + r.random.setup.bypass.cryptoRandom > 0).map((r) => r.name);
  const stepRandom = runs.filter((r) => r.random.run.seededRandomCalls > 0).map((r) => r.name);
  console.log(JSON.stringify({ out, scenarios: runs.length, ms, config: meta.config, bypass, stepRandom }));
}, 7_200_000);
