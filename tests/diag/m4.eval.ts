/// <reference types="node" />
/**
 * M4 实验的判定与报告（与 m4b.diag.ts 的 evaluate / deterministic / report 同一口径，供 A 阶段复用；m4b.diag.ts 保持原样作为 B1 / B2 的记录）。
 * 指标定义见 docs/engineering/m4-experiment-plan.md §2–§3；E6 的理论临界转速按当前实验的 g 与转速尺度 s 计算。
 */
import { beyMassProps } from '../../src/game/beys/massProps';
import { assembleBey, type AssembledBey } from '../../src/game/beys/parts/assemble';
import { SIGNATURE_LIST } from '../../src/game/beys/parts/catalog';
import { FLAT_TIP, GYRO_EXPERIMENT } from '../../src/game/physics/gyro';
import { beyByKey, median, phaseByKey, q, r2, r3, summarizeProcess, type RoundMetrics } from './m4.metrics';
import { PAIRS, runSet, soloSuite, type Example, type R } from './m4.runs';
import { matrixScenarios, out, runRound, summarize } from './m5b.shared';

/** M4-A 基准（m4a-baseline.md）：全程不退化项的参照 */
export const BASE = { ownShare: 2 / 320 };
export const MOVERS = ['lieren', 'senheng', 'ziyao'];
export type Group = 'E1' | 'E2' | 'E3' | 'E5';

/** 理论临界转速比例（力度 0.8）：ω_c = √(4 m g l I_t′) / I_a，平底按当前 FLAT_TIP 计算质量属性 */
export function critRatio(key: string, g: number, s = 1, prep?: (spec: AssembledBey) => AssembledBey): number {
  const sg = SIGNATURE_LIST.find((x) => x.key === key)!;
  const spec = prep ? prep(assembleBey(sg.loadout)) : assembleBey(sg.loadout);
  const flat = GYRO_EXPERIMENT.flatTip > 0 && (spec.bit.visual.shape === 'gear-flat' || spec.bit.visual.shape === 'rubber');
  const mp = beyMassProps(spec, { flatTip: flat ? FLAT_TIP : null });
  const l = mp.comY - spec.bit.contactRadius;
  const wc = Math.sqrt(4 * mp.mass * g * l * (mp.It + mp.mass * l * l)) / mp.Ia;
  return wc / ((prep ? spec.maxSpin : spec.maxSpin * s) * (0.4 + 0.6 * 0.8));
}

type Bin = { ratio: string; seconds: number; speed: number };

/** E2：0.5–0.6 档 / 0.8–1.0 档、0.3–0.4 档 / 0.8–1.0 档、0.2 以上相邻档最小比 */
export function e2Of(bins: Bin[]) {
  const get = (lo: string) => bins.find((b) => b.ratio.startsWith(lo));
  const hi = [get('0.9'), get('0.8')].filter((b): b is Bin => !!b);
  const secs = hi.reduce((a, b) => a + b.seconds, 0);
  const top = secs ? hi.reduce((a, b) => a + b.speed * b.seconds, 0) / secs : NaN;
  const s05 = get('0.5')?.speed ?? NaN;
  const s03 = get('0.3')?.speed ?? NaN;
  let minAdj = Infinity;
  for (let k = 9; k > 2; k--) {
    const a = get((k / 10).toFixed(1));
    const b = get(((k - 1) / 10).toFixed(1));
    if (a && b && a.speed > 1e-3) minAdj = Math.min(minAdj, b.speed / a.speed);
  }
  return { a: r3(s05 / top), b: r3(s03 / top), minAdj: r3(minAdj), pass: s05 / top >= 0.65 && s03 / top >= 0.4 && minAdj >= 0.6 };
}

export function evaluate(requires: Group[], solo: ReturnType<typeof soloSuite>, set: ReturnType<typeof runSet>, determinism: boolean, crit: (key: string) => number) {
  const sum = summarize(set.recs);
  const proc = summarizeProcess(set.metrics);
  const sp = (proc.finishProcess as Record<string, Record<string, number>>).spin ?? {};
  const E1 = {
    a: { v: sp.destabilizedShare, pass: sp.destabilizedShare >= 0.8 },
    b: { v: sp.durationP50, pass: sp.durationP50 >= 1 && sp.durationP50 <= 4 },
    c: { v: sp.risingShare, pass: sp.risingShare >= 0.7 },
    d: { v: sp.winnerBelowLoser, pass: sp.winnerBelowLoser >= 0.9 },
  };
  const e1 = Object.values(E1).every((x) => x.pass);
  const curves = set.curves as Record<string, { bins: Bin[] }>;
  const E2: Record<string, ReturnType<typeof e2Of>> = {};
  for (const k of MOVERS) if (curves[k]) E2[k] = e2Of(curves[k].bins);
  const e2 = MOVERS.every((k) => E2[k]?.pass);
  const E3: Record<string, number> = {};
  for (const k of MOVERS) E3[k] = solo.byName[k].last3SpeedOverMidP50 as number;
  const e3 = MOVERS.every((k) => E3[k] >= 0.5);
  const kr = proc.knockRecovery;
  const E4 = { ratio: r3((kr.mid.recoverP50 as number) / (kr.high.recoverP50 as number)), pass: (kr.mid.recoverP50 as number) / (kr.high.recoverP50 as number) >= 1.3 };
  const frozenOk = set.metrics.filter((m) => m.longestFrozen < 3).length / set.metrics.length;
  const E5 = { share: r3(frozenOk), maxFrozen: proc.longestFrozenMax, pass: frozenOk >= 0.99 };
  const E6: Record<string, unknown> = {};
  for (const sg of SIGNATURE_LIST) E6[sg.key] = { soloOnsetRatioP50: solo.byName[sg.key].destabOnsetRatioP50, theoryCritRatio: r3(crit(sg.key)) };
  const phase = phaseByKey(set.metrics.filter((m) => m.keys[0] !== m.keys[1])) as Record<string, { speed: number[] }>;
  const durs = set.metrics.map((m) => m.dur);
  const NR = {
    bad: { v: sum.bad, pass: sum.bad === 0 },
    ledger: { v: sum.spinLoss.residual.max, pass: sum.spinLoss.residual.max <= 0.01 },
    own: { v: sum.ownShare, pass: sum.ownShare <= BASE.ownShare + 0.03 + 1e-9 },
    duration: { p50: r2(median(durs)), atLimit: sum.atLimitShare, pass: median(durs) >= 8 && median(durs) <= 35 && sum.atLimitShare <= 0.15 },
    determinism: { pass: determinism },
    typeGap: { v: r3(phase.lieren?.speed[0] / phase.pandun?.speed[0]), pass: phase.lieren?.speed[0] / phase.pandun?.speed[0] >= 1.5 },
  };
  const nr = Object.values(NR).every((x) => x.pass);
  const groups: Record<string, boolean> = { E1: e1, E2: e2, E3: e3, E5: E5.pass };
  const pass = requires.every((g) => groups[g]) && nr;
  return { pass, groups, nonRegression: nr, E1, E2, E3, E4, E5, E6, NR, durationP90: r2(q(durs, 0.9)) };
}

/** 确定性：同一组场景跑两次，回合结果逐项相同 */
export function deterministic(R: R, n: number): boolean {
  const scs = matrixScenarios(20000, 20).slice(0, n);
  const a = scs.map((sc) => runRound(R, sc));
  const b = scs.map((sc) => runRound(R, sc));
  const key = (x: ReturnType<typeof runRound>) => JSON.stringify([x.kind, x.finish, x.winner, x.dur, x.sides[0].end, x.sides[1].end, x.sides[0].ledger, x.sides[1].ledger]);
  return a.every((x, i) => key(x) === key(b[i]));
}

export function report(tag: string, set: ReturnType<typeof runSet>, examples: Example[]) {
  const sum = summarize(set.recs);
  out(`${tag}-SUMMARY`, { ...sum, tactics: set.tactics, ms: set.ms });
  out(`${tag}-PROCESS`, summarizeProcess(set.metrics));
  const byPair: Record<string, unknown> = {};
  for (const [p, x, y] of PAIRS) byPair[p] = summarizeProcess(set.metrics.filter((m: RoundMetrics) => (m.keys[0] === x && m.keys[1] === y) || (m.keys[0] === y && m.keys[1] === x)));
  out(`${tag}-PROCESS-PAIRS`, byPair);
  out(`${tag}-PHASE`, phaseByKey(set.metrics.filter((m) => m.keys[0] !== m.keys[1])));
  out(`${tag}-BEY`, beyByKey(set.metrics.filter((m) => m.keys[0] !== m.keys[1])));
  out(`${tag}-CURVES`, set.curves);
  for (const e of examples) out(`${tag}-EXAMPLE`, e);
}
