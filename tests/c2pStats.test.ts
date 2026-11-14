import { describe, expect, it } from 'vitest';
import { seeded } from './motion/motionSim';
import { quantile } from './diag/m5b.shared';
import { chi2SfDf1, erfc, mcnemar } from './diag/c2p.math';
import { binaryStat, boxMuller, genBinary, genPaired, genSingle, groupMedian, pairedStat, S1_LAYOUT, simCases, SIM_SEEDS, singleStats, stratBootstrap, type BootStat } from './diag/c2p.stats';

/**
 * M4-C · C2-P 统计工具的规范测试（docs/engineering/m4c-c2-preregistration.md §7.1、§7.1.7，冻结于 1aab164）。
 * 覆盖率模拟（§7.1.3–§7.1.6，N_sim = 1000 × B = 2000，计算量大）按 §7.1.6 最后一条放在诊断任务 tests/diag/m4c-c2p-coverage.diag.ts。
 */

describe('§7.1.7 McNemar 与 erfc', () => {
  const T: [number, number, number, number, number, number][] = [
    [10, 4, 2.5714285714285716, 0.10880943004054569, 1.7857142857142858, 0.18144920772142034],
    [15, 5, 5.0, 0.025347318677468252, 4.05, 0.04417134490844261],
    [25, 10, 6.428571428571429, 0.011229886652916679, 5.6, 0.017960477526078766],
    [40, 20, 6.666666666666667, 0.009823274507519245, 6.016666666666667, 0.01417138825401233],
    [0, 7, 7.0, 0.008150971593502702, 5.142857142857143, 0.02334220201289082],
    [1, 0, 1.0, 0.31731050786291404, 0.0, 1.0],
    [3, 3, 0.0, 1.0, 0.0, 1.0],
  ];
  it('固定测试输入：χ² 与 χ²_cc 误差 ≤ 1e−12，p 值误差 ≤ 1e−10', () => {
    for (const [b, c, chi2, p, chi2cc, pcc] of T) {
      const r = mcnemar(b, c);
      if (!r.applicable) throw new Error('应可计算');
      expect(Math.abs(r.chi2 - chi2)).toBeLessThanOrEqual(1e-12);
      expect(Math.abs(r.chi2cc - chi2cc)).toBeLessThanOrEqual(1e-12);
      expect(Math.abs(r.p - p)).toBeLessThanOrEqual(1e-10);
      expect(Math.abs(r.pcc - pcc)).toBeLessThanOrEqual(1e-10);
    }
  });
  it('b = c = 0：返回“不适用”，不返回 NaN / Infinity / 占位值', () => {
    const r = mcnemar(0, 0);
    expect(r.applicable).toBe(false);
    expect(JSON.stringify(r)).not.toMatch(/NaN|Infinity|null/);
    expect(r).not.toHaveProperty('p');
    expect(r).not.toHaveProperty('chi2');
  });
  it('输入必须是非负整数', () => {
    expect(() => mcnemar(-1, 2)).toThrow();
    expect(() => mcnemar(1.5, 2)).toThrow();
  });
  it('p 值函数直接核对：3.841458820694124 → 0.05，6.634896601021214 → 0.01，1 → 0.31731050786291404', () => {
    expect(Math.abs(chi2SfDf1(3.841458820694124) - 0.05)).toBeLessThanOrEqual(1e-10);
    expect(Math.abs(chi2SfDf1(6.634896601021214) - 0.01)).toBeLessThanOrEqual(1e-10);
    expect(Math.abs(chi2SfDf1(1) - 0.31731050786291404)).toBeLessThanOrEqual(1e-10);
  });
  it('erfc 参考值（CPython math.erfc）：绝对误差 ≤ 1e−15', () => {
    const ref: [number, number][] = [
      [0, 1],
      [0.5, 0.4795001221869535],
      [1, 0.15729920705028513],
      [1.5, 0.033894853524689274],
      [2, 0.004677734981047265],
      [2.4999, 0.0004071699003334514],
      [2.5, 0.0004069520174449589],
      [3, 2.2090496998585438e-5],
      [5, 1.5374597944280351e-12],
      [-1, 1.842700792949715],
    ];
    for (const [x, v] of ref) expect(Math.abs(erfc(x) - v), `erfc(${x})`).toBeLessThanOrEqual(1e-15);
    expect(erfc(Infinity)).toBe(0);
    expect(Number.isNaN(erfc(NaN))).toBe(true);
  });
});

describe('§7.1 分层 bootstrap 的抽样步骤', () => {
  type Row = { id: string; g: 'A' | 'D' | null; v0: number; v1: number };
  const mk = (h: number, n: number, gs: ('A' | 'D' | null)[]): Row[] => Array.from({ length: n }, (_, i) => ({ id: `${h}:${i}`, g: gs[i] ?? null, v0: h * 10 + i, v1: h * 10 + i + 0.5 }));

  it('抽取顺序：按层顺序、层内抽 n_h 次 j = ⌊u·n_h⌋，同一随机数流贯穿 B 次重抽样', () => {
    const layers = [mk(0, 3, []), mk(1, 2, []), mk(2, 5, [])];
    const seen: string[][] = [];
    stratBootstrap(layers, 4, 777, [{ name: 'rec', fn: (rows, tok) => (tok && seen.push(rows.map((r) => r.id)), 0) }]);
    // 第 0 条是原始数据
    expect(seen[0]).toEqual(layers.flat().map((r) => r.id));
    const rnd = seeded(777);
    for (let b = 1; b <= 4; b++) {
      const want: string[] = [];
      for (const L of layers) for (let t = 0; t < L.length; t++) want.push(L[Math.floor(rnd() * L.length)].id);
      expect(seen[b]).toEqual(want);
    }
  });

  it('配对：同一次重抽样只有一套行下标，两臂的统计量在同一套行上计算', () => {
    const layers = [mk(0, 4, ['A', 'A', 'D']), mk(1, 3, ['A', 'D'])];
    const byTok = new Map<number, string[]>();
    const check = (rows: Row[], tok: number) => {
      const ids = rows.map((r) => r.id).join(',');
      const prev = byTok.get(tok);
      if (prev) expect(prev).toEqual([ids]);
      else byTok.set(tok, [ids]);
    };
    const s: BootStat<Row>[] = [
      { name: 'P0', fn: (rows, tok) => (check(rows, tok), rows.reduce((a, r) => a + r.v0, 0)) },
      { name: 'arm', fn: (rows, tok) => (check(rows, tok), rows.reduce((a, r) => a + r.v1, 0)) },
    ];
    const [r0, r1] = stratBootstrap(layers, 50, 1, s);
    expect(byTok.size).toBe(51);
    // 每次重抽样 v1 − v0 = 0.5 × 行数，所以两臂区间之差恰为常数（证明两臂用的是同一套行）
    expect(r1.lo - r0.lo).toBeCloseTo(3.5, 12);
    expect(r1.hi - r0.hi).toBeCloseTo(3.5, 12);
  });

  it('空组退化：不重抽、不补抽、B 不变；从百分位中剔除并按组 / 臂计数；任何一次退化 → 重抽样不稳定', () => {
    // 第 1 层只有 1 个 G_D（5 行中），所以有一部分重抽样里 G_D 为空
    const layers = [mk(0, 6, ['A', 'A', 'A', 'A', 'A', 'A']), mk(1, 5, [null, null, 'D'])];
    const pick = (rows: Row[], g: 'A' | 'D', arm: 'v0' | 'v1') => rows.filter((r) => r.g === g).map((r) => r[arm]);
    const vals: number[] = [];
    const stat: BootStat<Row> = {
      name: 'Δ',
      fn: (rows, tok) => {
        const a = groupMedian(pick(rows, 'A', 'v0'), 'G_A', 'P0');
        const d = groupMedian(pick(rows, 'D', 'v0'), 'G_D', 'P0');
        if (typeof a === 'number' && typeof d === 'number') {
          if (tok) vals.push(a - d);
          return a - d;
        }
        return { empty: [...(typeof a === 'number' ? [] : a.empty), ...(typeof d === 'number' ? [] : d.empty)] };
      },
    };
    const onlyA: BootStat<Row> = { name: 'A', fn: (rows) => groupMedian(pick(rows, 'A', 'v0'), 'G_A', 'P0') };
    const [r, ra] = stratBootstrap(layers, 400, 99, [stat, onlyA]);
    vals.shift(); // 原始数据
    expect(r.degenerate).toBeGreaterThan(0);
    expect(r.valid + r.degenerate).toBe(400);
    expect(r.degenerateB.length).toBe(r.degenerate);
    expect(r.degenerateBy).toEqual({ 'G_D|P0': r.degenerate });
    expect(r.unstable).toBe(true);
    expect(r.lo).toBe(quantile(vals, 0.025));
    expect(r.hi).toBe(quantile(vals, 0.975));
    // 只需要 G_A 的统计量不因 G_D 为空而退化
    expect(ra.degenerate).toBe(0);
    expect(ra.unstable).toBe(false);
  });

  it('非数值结果 → 统计分析失败：不给区间', () => {
    const [r] = stratBootstrap([[1, 2, 3]], 20, 5, [{ name: 'bad', fn: (rows) => (rows[0] === 3 ? NaN : 1) }]);
    expect(r.failed).not.toBeNull();
    expect(Number.isNaN(r.lo) && Number.isNaN(r.hi)).toBe(true);
  });

  it('同种子完全可复现；不同种子不同', () => {
    const layers = genSingle(S1_LAYOUT, 20, { kind: 'LN', mu: Math.log(0.12), sigma: 0.5 }, { kind: 'LN', mu: Math.log(0.08), sigma: 0.5 }, 1);
    const a = stratBootstrap(layers, 200, 12345, singleStats());
    const b = stratBootstrap(layers, 200, 12345, singleStats());
    const c = stratBootstrap(layers, 200, 12346, singleStats());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
  });
});

describe('§7.1.1–§7.1.5 覆盖率模拟的数据与用例表', () => {
  it('S1 布局 = §7.1.1 的表：G_A 206、G_D 22，G_D 只在 3 层', () => {
    expect(S1_LAYOUT.reduce((a, [x]) => a + x, 0)).toBe(206);
    expect(S1_LAYOUT.reduce((a, [, y]) => a + y, 0)).toBe(22);
    expect(S1_LAYOUT.filter(([, y]) => y > 0).length).toBe(3);
    const rows = genSingle(S1_LAYOUT, 20, { kind: 'U', a: 0.04, b: 0.2 }, { kind: 'U', a: 0.02, b: 0.14 }, 3).flat();
    expect(rows.length).toBe(320);
    expect(rows.filter((r) => r.g === 'A').length).toBe(206);
    expect(rows.filter((r) => r.g === 'D').length).toBe(22);
  });

  it('抽取顺序：均匀分布每个观测 1 个随机数、对数正态 2 个、配对连续 4 个、二元 1 个；无观测的行不取', () => {
    const rnd = seeded(42);
    const u = genSingle([[2, 1], [0, 0]], 3, { kind: 'U', a: 1, b: 3 }, { kind: 'U', a: 0, b: 1 }, 42).flat();
    expect(u[0].v).toBe(1 + 2 * rnd());
    expect(u[1].v).toBe(1 + 2 * rnd());
    expect(u[2].v).toBe(rnd());
    expect(u.slice(3).every((r) => r.g === null)).toBe(true);
    const r2 = seeded(7);
    const ln = genSingle([[1, 0]], 1, { kind: 'LN', mu: Math.log(0.1), sigma: 0.5 }, { kind: 'U', a: 0, b: 1 }, 7).flat();
    const u1 = r2();
    const u2 = r2();
    expect(ln[0].v).toBe(Math.exp(Math.log(0.1) + 0.5 * boxMuller(u1, u2)));
    expect(boxMuller(u1, u2)).toBe(Math.sqrt(-2 * Math.log(1 - u1)) * Math.cos(2 * Math.PI * u2));
    const r3 = seeded(9);
    const pr = genPaired([[1, 0]], 1, { A: 0.12, D: 0.08 }, { A: 0.15, D: 0.08 }, 0.5, 9).flat();
    const z0 = boxMuller(r3(), r3());
    const zp = boxMuller(r3(), r3());
    expect(pr[0].v0).toBe(Math.exp(Math.log(0.12) + 0.5 * z0));
    expect(pr[0].v1).toBe(Math.exp(Math.log(0.15) + 0.5 * (0.5 * z0 + Math.sqrt(1 - 0.25) * zp)));
  });

  it('二元用例：四格概率按 P₁₁、P₁₀、P₀₁、P₀₀ 累积；r = 0.8 可行；不可行组合报错', () => {
    expect(() => genBinary(0.35, 0.3, 0.8, 1)).not.toThrow();
    expect(() => genBinary(0.95, 0.9, 0.8, 1)).toThrow();
    const rows = genBinary(0.35, 0.3, 0.5, 11, 6, 20000).flat();
    const m0 = rows.reduce((a, r) => a + r.w0, 0) / rows.length;
    const m1 = rows.reduce((a, r) => a + r.w1, 0) / rows.length;
    expect(m0).toBeCloseTo(0.35, 2);
    expect(m1).toBeCloseTo(0.3, 2);
  });

  it('用例表 c = 0–19 与 §7.1.5 一致（类别、验收 / 只报告、报告的量、真值）', () => {
    const cs = simCases();
    expect(cs.map((c) => c.c)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(cs.filter((c) => !c.accept).map((c) => c.c)).toEqual([3, 4, 5, 18, 19]);
    for (const c of cs.slice(0, 6)) expect(Object.keys(c.truth)).toEqual(['Q1', 'Q2', 'Q3']);
    for (const c of cs.slice(6, 12)) expect(Object.keys(c.truth)).toEqual(['Q4']);
    for (const c of cs.slice(12)) expect(Object.keys(c.truth)).toEqual(['Q5']);
    expect(cs.map((c) => Object.values(c.truth).join('/'))).toEqual([
      '0.12/0.08/0.04', '0.12/0.08/0.04', '0.1/0.1/0', '0.12/0.08/0.04', '0.12/0.08/0.04', '0.1/0.1/0',
      '0.03', '0.03', '0.03', '0', '0', '0',
      '-0.05', '-0.05', '-0.05', '0', '0', '0', '-0.05', '-0.05',
    ]);
    expect(cs[3].gen(1).length).toBe(16);
    expect(cs[3].gen(1)[0].length).toBe(40);
    expect(SIM_SEEDS.gen(7, 3)).toBe(71_070_003);
    expect(SIM_SEEDS.boot(19, 999)).toBe(72_190_999);
  });

  it('统计量：Q4 配对连续在两臂观测位置相同；Q5 每次都有全部行、不退化', () => {
    const p = genPaired(S1_LAYOUT, 20, { A: 0.12, D: 0.08 }, { A: 0.12, D: 0.08 }, 0, 5);
    const [q4] = stratBootstrap(p, 100, 1, pairedStat());
    expect(q4.valid + q4.degenerate).toBe(100);
    const bin = genBinary(0.35, 0.35, 0, 5);
    const [q5] = stratBootstrap(bin, 100, 1, binaryStat());
    expect(q5.degenerate).toBe(0);
    expect(q5.valid).toBe(100);
  });
});
