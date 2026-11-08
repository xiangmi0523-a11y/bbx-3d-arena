/**
 * 探针 V2 跨树基线对照：不带任何探针，只跑物理并输出逐场逐步状态指纹。
 * 这个文件与 stallprobe2.shared.ts 一起原样复制到干净的 cb4c2c4 工作树运行，
 * 结果与本分支探针运行的逐场指纹比对（scripts/stallprobe2-verify.mjs）。
 *   SP2_PLAIN_OUT=文件  SP_GROUPS=AvD,...  DIAG_TUNE='{"stallBreak":1}'
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { test } from 'vitest';
import { BEY_TUNING } from '../../src/game/beys/BeyPhysics';
import { loadRapier } from '../../src/game/physics/PhysicsWorld';
import { plainRun, scenariosV2 } from './stallprobe2.shared';

if (process.env.DIAG_TUNE) Object.assign(BEY_TUNING, JSON.parse(process.env.DIAG_TUNE));

test('stall probe v2 plain baseline', async () => {
  const R = await loadRapier();
  const out = process.env.SP2_PLAIN_OUT ?? 'test-results/stallprobe2/plain.json';
  mkdirSync(dirname(out), { recursive: true });
  const want = process.env.SP_GROUPS?.split(',') ?? null;
  let head = '';
  let dirty = '';
  try {
    head = execSync('git rev-parse HEAD').toString().trim();
    dirty = execSync('git status --porcelain --untracked-files=no').toString().trim();
  } catch {
    /* 非 git 目录 */
  }
  const runs: unknown[] = [];
  for (const sc of scenariosV2()) {
    if (want && !want.includes(sc.group)) continue;
    runs.push({ name: sc.name, group: sc.group, seed: sc.seed, ...(await plainRun(R, sc)) });
  }
  writeFileSync(out, JSON.stringify({ head, trackedDirty: dirty, tune: process.env.DIAG_TUNE ?? null, runs }, null, 1));
}, 7_200_000);
