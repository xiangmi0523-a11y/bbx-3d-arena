/// <reference types="node" />
/**
 * M4-C · C2-P bootstrap 覆盖率模拟（docs/engineering/m4c-c2-preregistration.md §7.1.1–§7.1.6，冻结于 1aab164）。
 * 用例 c = 0–19（§7.1.5 用例表）、N_sim = 1000、B = 2000；生成种子 71 000 000 + 10 000·c + k，bootstrap 种子 72 000 000 + 10 000·c + k。
 * 每个用例、每个量报告：C_valid（有效区间覆盖率）、D_ds（退化数据集比例）、D_rs（退化重抽样比例）、C_cons（保守综合指标，不是覆盖率）、
 * 覆盖 / 退化计数，以及全部 [L, U]（toPrecision(17)）的 SHA-256。验收用例要求 C_cons ∈ [0.93, 0.97]（§7.1.6）。
 * §7.1.3 小样本规则：c = 0–2 中 Q2 或 Q3 的 C_cons 低于 0.93 → 正式分析中涉及 G_D 的区间一律标“重抽样不稳定”、P4 记不确定（方法与阈值不改）。
 * 输出行首 C2P-COV-（同时写入 test-results/diag-out.jsonl 与 test-results/c2p-cov.jsonl）。环境变量 C2P_COV_CASES=0,1,… 只跑部分用例：
 * CI 把 20 个用例分给 4 个并行进程（scripts/ci-diag.sh），用例、种子、N_sim、B 不变；汇总与验收判断在 m4c-c2p-analysis.diag.ts 中对全部用例进行。
 */
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { test } from 'vitest';
import { simCases, SIM_SEEDS, stratBootstrap } from './c2p.stats';
import { out } from './m5b.shared';

const N_SIM = 1000;
const B = 2000;
const ACCEPT = [0.93, 0.97] as const;

test('C2-P bootstrap 覆盖率模拟（c = 0–19）', () => {
  const only = process.env.C2P_COV_CASES ? process.env.C2P_COV_CASES.split(',').map(Number) : null;
  const t0 = Date.now();
  const summary: Record<string, unknown>[] = [];
  for (const cs of simCases()) {
    if (only && !only.includes(cs.c)) continue;
    const t1 = Date.now();
    const names = Object.keys(cs.truth);
    const acc = Object.fromEntries(names.map((q) => [q, { covered: 0, nondeg: 0, degDatasets: 0, degResamples: 0, failed: 0, lines: [] as string[] }]));
    for (let k = 0; k < N_SIM; k++) {
      const layers = cs.gen(SIM_SEEDS.gen(cs.c, k));
      const res = stratBootstrap(layers as never[][], B, SIM_SEEDS.boot(cs.c, k), cs.stats());
      for (const r of res) {
        const a = acc[r.name];
        const truth = cs.truth[r.name];
        a.lines.push(`${r.lo.toPrecision(17)},${r.hi.toPrecision(17)}`);
        if (r.failed) {
          a.failed++;
          continue;
        }
        a.degResamples += r.degenerate;
        if (r.unstable) a.degDatasets++;
        else {
          a.nondeg++;
          if (r.lo <= truth && truth <= r.hi) a.covered++;
        }
      }
    }
    for (const q of names) {
      const a = acc[q];
      const cCons = a.covered / N_SIM;
      const row = {
        c: cs.c,
        kind: cs.kind,
        role: cs.accept ? '验收' : '只报告',
        q,
        truth: cs.truth[q],
        N_sim: N_SIM,
        B,
        covered: a.covered,
        nondegenerate: a.nondeg,
        degenerateDatasets: a.degDatasets,
        failedDatasets: a.failed,
        C_valid: a.nondeg ? a.covered / a.nondeg : null,
        D_ds: a.degDatasets / N_SIM,
        D_rs: a.degResamples / (N_SIM * B),
        C_cons: cCons,
        withinAccept: cCons >= ACCEPT[0] && cCons <= ACCEPT[1],
        belowLower: cCons < ACCEPT[0],
        sha256: createHash('sha256').update(a.lines.join('\n')).digest('hex'),
        ms: Date.now() - t1,
      };
      out('C2P-COV-CASE', row);
      mkdirSync('test-results', { recursive: true });
      appendFileSync('test-results/c2p-cov.jsonl', `${JSON.stringify(row)}\n`);
      summary.push(row);
    }
  }
  const acceptRows = summary.filter((r) => r.role === '验收');
  const smallSample = summary.filter((r) => (r.c as number) <= 2 && (r.q === 'Q2' || r.q === 'Q3'));
  out('C2P-COV-SUMMARY', {
    cases: [...new Set(summary.map((r) => r.c))].length,
    complete: !only,
    acceptAll: acceptRows.every((r) => r.withinAccept && r.failedDatasets === 0),
    acceptFailures: acceptRows.filter((r) => !r.withinAccept || (r.failedDatasets as number) > 0).map((r) => `c${r.c}:${r.q}=${(r.C_cons as number).toFixed(3)}`),
    /** §7.1.3：c = 0–2 的 Q2 / Q3 低于下限 → 正式分析中涉及 G_D 的区间一律“重抽样不稳定”，P4 不确定 */
    smallSampleRuleTriggered: smallSample.some((r) => r.belowLower),
    ms: Date.now() - t0,
    node: process.version,
  });
}, 3600000);
