/// <reference types="node" />
/**
 * E-CF：取消碗面中心平台的确认实验（产品决定 D2；预注册规则见 docs/engineering/m5b-experiment-plan.md §2，本脚本只实现、不改规则）。
 *
 * 臂：base（centerFlat 0.6）/ flat0（centerFlat 0）；其余为 PR #11 的最终参数。
 * 签名矩阵 4 × 4 × 65（seed = 40000 + 1000·p + 100·r + i），每臂 1040 回合；
 * 僵持探针：磐盾镜像 40 场（seed 47000 + i）、紫曜镜像 40 场（seed 47100 + i），回合上限 120 s，定义与 M2 B 部分相同。
 * 输出（行首 M5B-CF）：每臂汇总（含 D4 掉速口径与整场时长估计）与最终判定（B1、N1–N4 逐项 pass / fail）。
 *
 * 用法：npx vitest run --config vitest.diag.config.ts tests/diag/m5b-confirm.diag.ts -t "E-CF"
 */
import { test } from 'vitest';
import { SIGNATURE_LIST } from '../../src/game/beys/parts/catalog';
import { loadRapier } from '../../src/game/physics/PhysicsWorld';
import { chiSquare2xK, finishVector, matchEstimate, matrixScenarios, mirrorProbes, newcombe, out, probe, probePool, r3, runRound, summarize, withArena, withRules } from './m5b.shared';

test('E-CF：取消碗面中心平台（预注册，m5b-experiment-plan.md §2）', async () => {
  const R = await loadRapier();
  const scs = matrixScenarios(40000, 65);
  const arms: { arm: 'base' | 'flat0'; o: { centerFlat?: number } }[] = [
    { arm: 'base', o: {} },
    { arm: 'flat0', o: { centerFlat: 0 } },
  ];
  const res: Record<string, { sum: ReturnType<typeof summarize>; nn: ReturnType<typeof probePool>; bb: ReturnType<typeof probePool>; fv: number[] }> = {};
  for (const a of arms) {
    const t0 = Date.now();
    const recs = withArena(a.o, () => scs.map((sc) => runRound(R, sc)));
    const nn = withArena(a.o, () => withRules({ roundTimeLimit: 120 }, () => mirrorProbes('pandun', 47000, 40, 121).map((sc) => probe(R, sc, 121))));
    const bb = withArena(a.o, () => withRules({ roundTimeLimit: 120 }, () => mirrorProbes('ziyao', 47100, 40, 121).map((sc) => probe(R, sc, 121))));
    const sum = summarize(recs);
    res[a.arm] = { sum, nn: probePool(nn), bb: probePool(bb), fv: finishVector(recs) };
    out(`M5B-CF ${a.arm}`, { ms: Date.now() - t0, ...sum, needleMirror: res[a.arm].nn, ballMirror: res[a.arm].bb, matchEstimate: matchEstimate(recs), needleRows: nn.map((r) => [r.longestIdle, r.recontactHit, r.recontactN, r.finish]) });
  }
  const b = res.base;
  const f = res.flat0;
  // B1 收益：针尖镜像最长无接触低速段中位数下降 ≥ 50%，且 2 s 重接触率提高 ≥ 10 个百分点
  const idleDrop = b.nn.longestIdleP50 > 0 ? 1 - f.nn.longestIdleP50 / b.nn.longestIdleP50 : 0;
  const recUp = f.nn.recontact.rate - b.nn.recontact.rate;
  const B1 = { idleP50: [b.nn.longestIdleP50, f.nn.longestIdleP50], idleDrop: r3(idleDrop), recontact: [b.nn.recontact.rate, f.nn.recontact.rate], recontactUp: r3(recUp), pass: idleDrop >= 0.5 && recUp >= 0.1 };
  // N1 四构筑胜率：|Δ| ≤ 5 个百分点（点估计），报告差的 95% CI
  const n1: Record<string, unknown> = {};
  let n1pass = true;
  for (const sg of SIGNATURE_LIST) {
    const x = b.sum.perSignature[sg.key];
    const y = f.sum.perSignature[sg.key];
    const d = y.win - x.win;
    const ci = newcombe(x.k, x.n, y.k, y.n);
    const ok = Math.abs(d) <= 0.05;
    if (!ok) n1pass = false;
    n1[sg.key] = { base: x.win, flat0: y.win, delta: r3(d), ci95: [r3(ci[0]), r3(ci[1])], pass: ok };
  }
  // N2 自灭率：≤ base + 2 个百分点
  const N2 = { base: b.sum.ownShare, flat0: f.sum.ownShare, pass: f.sum.ownShare <= b.sum.ownShare + 0.02 + 1e-9 };
  // N3 时长：中位数变化 ±2 s 内，打满 60 s 上限的占比增加 ≤ 1 个百分点
  const N3 = { durationP50: [b.sum.durationP50, f.sum.durationP50], atLimit: [b.sum.atLimitShare, f.sum.atLimitShare], pass: Math.abs(f.sum.durationP50 - b.sum.durationP50) <= 2 && f.sum.atLimitShare - b.sum.atLimitShare <= 0.01 + 1e-9 };
  // N4 终结分布：卡方 p ≥ 0.01
  const chi = chiSquare2xK(b.fv, f.fv);
  const N4 = { base: b.fv, flat0: f.fv, chi2: r3(chi.chi2), df: chi.df, p: r3(chi.p), pass: chi.p >= 0.01 };
  const adopt = B1.pass && n1pass && N2.pass && N3.pass && N4.pass;
  out('M5B-CF verdict', {
    B1,
    N1: { pass: n1pass, perSignature: n1 },
    N2,
    N3,
    N4,
    m4Target: { needleIdleOver5: [b.nn.idleOver5, f.nn.idleOver5], needleRecontactRate: [b.nn.recontact.rate, f.nn.recontact.rate], ballIdleP50: [b.bb.longestIdleP50, f.bb.longestIdleP50] },
    adopt,
  });
}, 3_000_000);
