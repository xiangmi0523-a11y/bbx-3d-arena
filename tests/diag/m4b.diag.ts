/// <reference types="node" />
/**
 * M4-B 实验臂（docs/engineering/m4-experiment-plan.md §3–§4，预注册）。每个臂跑与 M4-A 相同的单台套件与签名矩阵
 * （筛选 20000 × 20；筛选通过后确认 60000 × 40），计算 E1–E6 与全程不退化项，按 §4 的判定规则给出结论。
 * 开关只在本文件运行期间打开，结束后恢复默认（golden 不受影响）。输出行首 M4B-<臂>-。
 *
 * 用法：M4B_ARM=B1 npx vitest run --config vitest.diag.config.ts tests/diag/m4b.diag.ts
 */
import { test } from 'vitest';
import { GRAVITY, loadRapier } from '../../src/game/physics/PhysicsWorld';
import { GYRO_EXPERIMENT } from '../../src/game/physics/gyro';
import { beyMassProps } from '../../src/game/beys/massProps';
import { assembleBey } from '../../src/game/beys/parts/assemble';
import { SIGNATURE_LIST } from '../../src/game/beys/parts/catalog';
import { beyByKey, median, phaseByKey, q, r2, r3, summarizeProcess, type RoundMetrics } from './m4.metrics';
import { PAIRS, runSet, soloSuite, type Example, type R } from './m4.runs';
import { matrixScenarios, out, runRound, summarize } from './m5b.shared';

interface Arm {
  gyro: Partial<typeof GYRO_EXPERIMENT>;
  /** 判定必须通过的指标组（§4 判定规则） */
  requires: ('E1' | 'E2' | 'E3' | 'E5')[];
  note: string;
}

const ARMS: Record<string, Arm> = {
  B1: { gyro: { enabled: 1, pd: 0, tiltDrive: 1 }, requires: ['E1', 'E5'], note: '陀螺项开；自稳 PD 关；牵引方向取实际倾斜、大小乘接地点偏移比例；意图进动调制暂停' },
};

/** M4-A 基准（m4a-baseline.md）：全程不退化项的参照 */
const BASE = { ownShare: 2 / 320 };
const MOVERS = ['lieren', 'senheng', 'ziyao'];

function withArm<T>(a: Arm, fn: () => T): T {
  const old = { ...GYRO_EXPERIMENT };
  Object.assign(GYRO_EXPERIMENT, a.gyro);
  try {
    return fn();
  } finally {
    Object.assign(GYRO_EXPERIMENT, old);
  }
}

/** 理论临界转速比例（与 M4-A THEORY 同一公式，力度 0.8） */
function critRatio(key: string): number {
  const sg = SIGNATURE_LIST.find((s) => s.key === key)!;
  const spec = assembleBey(sg.loadout);
  const mp = beyMassProps(spec);
  const g = -GRAVITY;
  const l = mp.comY - spec.bit.contactRadius;
  const wc = Math.sqrt(4 * mp.mass * g * l * (mp.It + mp.mass * l * l)) / mp.Ia;
  return wc / (spec.maxSpin * (0.4 + 0.6 * 0.8));
}

type Bin = { ratio: string; seconds: number; speed: number };

/** E2：0.5–0.6 档 / 0.8–1.0 档、0.3–0.4 档 / 0.8–1.0 档、0.2 以上相邻档最小比 */
function e2Of(bins: Bin[]) {
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

function evaluate(arm: Arm, solo: ReturnType<typeof soloSuite>, set: ReturnType<typeof runSet>, determinism: boolean) {
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
  for (const sg of SIGNATURE_LIST) E6[sg.key] = { soloOnsetRatioP50: solo.byName[sg.key].destabOnsetRatioP50, theoryCritRatio: r3(critRatio(sg.key)) };
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
  const pass = arm.requires.every((g) => groups[g]) && nr;
  return { pass, groups, nonRegression: nr, E1, E2, E3, E4, E5, E6, NR, durationP90: r2(q(durs, 0.9)) };
}

/** 确定性：同一组场景跑两次，回合结果逐项相同 */
function deterministic(R: R, n: number): boolean {
  const scs = matrixScenarios(20000, 20).slice(0, n);
  const a = scs.map((sc) => runRound(R, sc));
  const b = scs.map((sc) => runRound(R, sc));
  const key = (x: ReturnType<typeof runRound>) => JSON.stringify([x.kind, x.finish, x.winner, x.dur, x.sides[0].end, x.sides[1].end, x.sides[0].ledger, x.sides[1].ledger]);
  return a.every((x, i) => key(x) === key(b[i]));
}

function report(tag: string, set: ReturnType<typeof runSet>, examples: Example[]) {
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

test('M4-B 实验臂（M4B_ARM）', async () => {
  const name = process.env.M4B_ARM;
  if (!name) {
    console.log('未设置 M4B_ARM，跳过');
    return;
  }
  const arm = ARMS[name];
  if (!arm) throw new Error(`未知的臂 ${name}`);
  const R = await loadRapier();
  const tag = `M4B-${name}`;
  out(`${tag}-ARM`, { name, ...arm });
  const res = withArm(arm, () => {
    const solo = soloSuite(R);
    for (const x of solo.recs) out(`${tag}-SOLO-RUN`, x);
    out(`${tag}-SOLO`, { ms: solo.ms, byName: solo.byName });
    const det = deterministic(R, 16);
    const exS: Example[] = [];
    const screen = runSet(R, matrixScenarios(20000, 20), 'screen', exS);
    report(`${tag}-SCREEN`, screen, exS);
    const vs = evaluate(arm, solo, screen, det);
    out(`${tag}-SCREEN-VERDICT`, vs);
    let vc: ReturnType<typeof evaluate> | null = null;
    if (vs.pass) {
      const exC: Example[] = [];
      const conf = runSet(R, matrixScenarios(60000, 40), 'confirm', exC);
      report(`${tag}-CONFIRM`, conf, exC);
      vc = evaluate(arm, solo, conf, det);
      out(`${tag}-CONFIRM-VERDICT`, vc);
    }
    return { screen: vs.pass, confirm: vc ? vc.pass : null };
  });
  out(`${tag}-RESULT`, { arm: name, screenPass: res.screen, confirmPass: res.confirm, adopted: res.screen && res.confirm === true });
});
