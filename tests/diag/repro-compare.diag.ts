/**
 * 对照两份记录（repro.diag.ts 的输出，或 tests/fixtures/repro-golden.json 摘要）。
 *   REPRO_A=a.json REPRO_B=b.json [REPRO_REPORT=report.json] npx vitest run --config vitest.diag.config.ts tests/diag/repro-compare.diag.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from 'vitest';
import { compareTraces } from '../repro/compare';

test('repro: 对照两份记录', () => {
  const load = (f: string) => JSON.parse(readFileSync(f, 'utf8'));
  const A = load(process.env.REPRO_A!);
  const B = load(process.env.REPRO_B!);
  const rep = compareTraces(A.runs, B.runs);
  const out = { a: { file: process.env.REPRO_A, head: A.head ?? A.generatedFrom, order: A.order }, b: { file: process.env.REPRO_B, head: B.head ?? B.generatedFrom, order: B.order }, ...rep };
  if (process.env.REPRO_REPORT) writeFileSync(process.env.REPRO_REPORT, JSON.stringify(out, null, 1));
  console.log(JSON.stringify({ ...out, diffs: rep.diffs.slice(0, 5), diffCount: rep.diffs.length }, null, 1));
});
