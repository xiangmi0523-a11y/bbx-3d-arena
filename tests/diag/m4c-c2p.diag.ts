/// <reference types="node" />
/**
 * M4-C · C2-P 实验：运行一个臂、一个集合（docs/engineering/m4c-c2-preregistration.md §4、§6，冻结于 1aab164）。
 * 环境变量：C2P_SET = S1 | S4，C2P_ARM = P0 | Pa | Pb | Pc；S3 的 Δp 取 C2P_DP，没有时读 test-results/c2p-calib.json（m4c-c2p-calib.diag.ts 的标定结果）。
 * 同种子运行两次：第二次只用于确定性比较（逐步状态哈希 + 逐行结果）。
 * 输出（同时写入 test-results/c2p-<set>-<arm>.jsonl）：C2P-ROW（对战每回合一行）、C2P-S2、C2P-S3、C2P-ARM（汇总、审计、自检、分布）。
 * 运行：C2P_SET=S1 C2P_ARM=Pb npx vitest run --config vitest.diag.config.ts tests/diag/m4c-c2p.diag.ts
 */
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'vitest';
import { loadRapier } from '../../src/game/physics/PhysicsWorld';
import { aggReport, ARMS, AUDIT, emit, runArm, summarize, type ArmName, type SetName } from './m4c-c2p.shared';

test('C2-P 实验臂运行', async () => {
  const set = (process.env.C2P_SET ?? 'S1') as SetName;
  const arm = process.env.C2P_ARM as ArmName;
  if (!(arm in ARMS)) throw new Error(`C2P_ARM 必须是 ${Object.keys(ARMS).join(' / ')}`);
  if (set !== 'S1' && set !== 'S4') throw new Error('C2P_SET 必须是 S1 或 S4');
  let dp = Number(process.env.C2P_DP);
  if (!Number.isFinite(dp)) {
    if (!existsSync('test-results/c2p-calib.json')) throw new Error('缺少 S3 标定结果（先运行 m4c-c2p-calib.diag.ts）');
    dp = JSON.parse(readFileSync('test-results/c2p-calib.json', 'utf8')).dp;
  }
  const R = await loadRapier();
  const file = `c2p-${set}-${arm}.jsonl`;
  const t0 = Date.now();
  AUDIT.bad = 0;
  const a = runArm(R, set, arm, dp, true, (row) => emit(file, 'C2P-ROW', row));
  const badA = AUDIT.bad;
  for (const r of a.solo) emit(file, 'C2P-S2', r);
  for (const r of a.s3) emit(file, 'C2P-S3', r);
  AUDIT.bad = 0;
  const b = runArm(R, set, arm, dp, false);
  const badB = AUDIT.bad;
  const hashMismatch = a.hashes.length === b.hashes.length ? a.hashes.filter((h, i) => h !== b.hashes[i]).length : -1;
  const rowsA = JSON.stringify([a.rows, a.solo, a.s3]);
  const rowsB = JSON.stringify([b.rows, b.solo, b.s3]);
  const sum = summarize(a.recs);
  emit(file, 'C2P-ARM', {
    set,
    arm,
    budget: ARMS[arm],
    dp,
    rounds: a.rows.length,
    solo: a.solo.length,
    s3: a.s3.length,
    determinism: { identical: hashMismatch === 0 && rowsA === rowsB, hashes: a.hashes.length, hashMismatch, rowsIdentical: rowsA === rowsB },
    audit: { badSteps: badA, badStepsPass2: badB, badRounds: sum.bad, ledgerResidualMax: sum.spinLoss.residual.max, ledgerResidual: sum.spinLoss.residual },
    checks: a.checks,
    checksPass2: b.checks,
    ownShare: sum.ownShare,
    atLimitShare: sum.atLimitShare,
    counts: sum.counts,
    ms: { pass1: a.ms, pass2: b.ms, total: Date.now() - t0 },
    agg: aggReport(a.agg),
  });
}, 3600000);
