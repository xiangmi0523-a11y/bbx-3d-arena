/**
 * 第三轮：physics.test「P2.3.1 不会长时间原地互转」用例的逐场明细（同一 feelRun、同一种子、同一 40 秒上限），
 * 用来看关闭通用僵持脱困后这条用例具体差多少。只读、不改用例。
 *   FS_OUT=test-results/motion/fs-B.json npx vitest run --config vitest.diag.config.ts tests/diag/feelstall.diag.ts
 *   A 配置：DIAG_TUNE='{"stallBreak":1}'
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { test } from 'vitest';
import { BEY_TUNING } from '../../src/game/beys/BeyPhysics';
import { feelRun } from '../feelSim';

if (process.env.DIAG_TUNE) Object.assign(BEY_TUNING, JSON.parse(process.env.DIAG_TUNE));

test('feel stall', async () => {
  const RIVAL = { blade: 'tidal-bastion', disc: 'hex-lock', tip: 'dome-ball' };
  const BAL = { blade: 'gale-crescent', disc: 'hex-lock', tip: 'dome-ball' };
  const STA = { blade: 'titan-crown', disc: 'hex-lock', tip: 'needle-point' };
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < 6; i++) rows.push({ case: 'BAL vs RIVAL', seed: 1000 + i, ...(await feelRun({ player: BAL, rival: RIVAL }, 1000 + i, 40)) });
  for (let i = 0; i < 4; i++) rows.push({ case: 'STA vs STA(tidal)', seed: 3000 + i, ...(await feelRun({ player: STA, rival: { ...STA, blade: 'tidal-bastion' } }, 3000 + i, 40)) });
  const out = process.env.FS_OUT ?? 'test-results/motion/fs-now.json';
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(rows, null, 1));
}, 600000);
