import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { test } from 'vitest';
import { BEY_TUNING } from '../../src/game/beys/BeyPhysics';
import { INTENT_TUNING } from '../../src/game/beys/motionIntent';
import { runMotion, type MotionRun } from '../motion/motionSim';
import { groups, TRACE_PICKS } from '../motion/scenarios';

/**
 * 自主运动固定种子对比（无头真实物理）。
 *   MOTION_OUT=test-results/motion/new.json npx vitest run --config vitest.diag.config.ts tests/diag/motion.diag.ts
 * 基线对比：把 tests/motion/ 与本文件拷到 0dac2ad 的工作树里跑同一命令，输出到另一个 JSON。
 * MOTION_ONLY=AvD,BvB 只跑部分组。
 */
if (process.env.DIAG_INTENT) Object.assign(INTENT_TUNING, JSON.parse(process.env.DIAG_INTENT));
if (process.env.DIAG_TUNE) Object.assign(BEY_TUNING, JSON.parse(process.env.DIAG_TUNE));

test('motion matrix', async () => {
  const out = process.env.MOTION_OUT ?? 'test-results/motion/now.json';
  const only = process.env.MOTION_ONLY?.split(',');
  const res: Record<string, MotionRun[]> = {};
  for (const g of groups()) {
    if (only && !only.includes(g.key)) continue;
    res[g.key] = [];
    for (const sc of g.scenarios) {
      res[g.key].push(await runMotion({ ...sc, trace: TRACE_PICKS.includes(sc.name) }));
    }
    const rs = res[g.key];
    const m = (f: (r: MotionRun) => number) => (rs.map(f).filter(Number.isFinite).reduce((s, v, _, a) => s + v / a.length, 0)).toFixed(2);
    console.log(
      `${g.key}: dur ${m((r) => r.duration)} pCos ${m((r) => r.p.pursuitCos)} rCos ${m((r) => r.r.pursuitCos)} chase ${m((r) => r.p.chaseFrac)} orbit ${m((r) => r.p.orbitFrac)} contactFrac ${m((r) => r.contactFrac)} longest ${m((r) => r.longestContact)} sep ${m((r) => r.separations)} cut ${m((r) => r.cutAngleMedian)} hits ${m((r) => r.hits)} brk ${m((r) => r.breakouts)} ${rs.map((r) => r.result).join(' ')}`,
    );
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(res));
});
