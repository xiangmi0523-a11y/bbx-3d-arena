/**
 * M4-C · C2-P 分层成组 / 分层配对 bootstrap 与覆盖率模拟的数据生成。
 * 规范：docs/engineering/m4c-c2-preregistration.md §7.1、§7.2（冻结于 1aab164），逐条对应：
 *  - 抽样单位 = 场景行；层 = 有序对阵（按调用方给的层顺序）；层内有放回抽 n_h 次，下标 j = ⌊u·n_h⌋；
 *  - 第 b 次重抽样只生成一套行下标，所有臂、所有统计量共用（配对）；组由抽中行的标签决定，不单独抽样；
 *  - 统计量所需的任一组在任一所需臂上为空 → 第 b 次对该统计量退化：不重抽、不补抽、B 不变，从百分位计算中剔除，
 *    记录（b、统计量、为空的组、为空的臂）；只要出现一次退化，区间标为“重抽样不稳定”；
 *  - 中位数 = m4.metrics.ts 的 median；区间端点 = m5b.shared.ts 的 quantile（最近秩）取 0.025 / 0.975；随机数 = motionSim.ts 的 seeded。
 * 测试：tests/c2pStats.test.ts（抽样步骤、配对、退化）；覆盖率模拟：tests/diag/m4c-c2p-coverage.diag.ts。
 */
import { seeded } from '../motion/motionSim';
import { median } from './m4.metrics';
import { quantile } from './m5b.shared';

/** 统计量在一次重抽样上的结果：数值，或退化（列出为空的组 / 臂） */
export type StatValue = number | { empty: { group: string; arm: string }[] };

export interface BootStat<Row> {
  name: string;
  /** rows = 本次重抽样抽中的行（多重集，原始数据时为全部行）；tok = 本次计算的唯一编号（跨调用唯一），只用于同一次重抽样内多个统计量共用中间结果 */
  fn: (rows: Row[], tok: number) => StatValue;
}

export interface BootResult {
  name: string;
  B: number;
  /** 原始数据上的点估计（原始数据退化时为 null，并给出为空的组） */
  point: number | null;
  pointEmpty: { group: string; arm: string }[] | null;
  lo: number;
  hi: number;
  valid: number;
  degenerate: number;
  /** 按“组 | 臂”分别计数的退化次数 */
  degenerateBy: Record<string, number>;
  /** 退化的重抽样编号 b（1 … B） */
  degenerateB: number[];
  /** 出现任何一次退化 → 重抽样不稳定（§7.2 第 4 条） */
  unstable: boolean;
  /** 统计分析失败（非数值结果，§7.2 第 5 条）：不报告区间 */
  failed: string | null;
}

const isNum = (v: StatValue): v is number => typeof v === 'number';
/** 每次重抽样（与原始数据计算）的唯一编号 */
let TOKEN = 0;

/**
 * 分层 bootstrap（单臂与配对通用：配对时行里带各臂的标签，统计量函数在同一套行上分别计算各臂再相减）。
 * layers：按层顺序排列的行；seed：随机数种子（正式分析 12345，覆盖率模拟 72 000 000 + 10 000·c + k）。
 */
export function stratBootstrap<Row>(layers: Row[][], B: number, seed: number, stats: BootStat<Row>[]): BootResult[] {
  const rnd = seeded(seed);
  const all = layers.flat();
  const vals: number[][] = stats.map(() => []);
  const tok0 = ++TOKEN;
  const res: BootResult[] = stats.map((s) => {
    const p = s.fn(all, tok0);
    return {
      name: s.name,
      B,
      point: isNum(p) ? p : null,
      pointEmpty: isNum(p) ? null : p.empty,
      lo: NaN,
      hi: NaN,
      valid: 0,
      degenerate: 0,
      degenerateBy: {},
      degenerateB: [],
      unstable: false,
      failed: null,
    };
  });
  const total = layers.reduce((a, l) => a + l.length, 0);
  const picked: Row[] = new Array(total);
  for (let b = 1; b <= B; b++) {
    let k = 0;
    for (const L of layers) {
      const n = L.length;
      for (let t = 0; t < n; t++) picked[k++] = L[Math.floor(rnd() * n)];
    }
    const tok = ++TOKEN;
    for (let si = 0; si < stats.length; si++) {
      const r = res[si];
      if (r.failed) continue;
      const v = stats[si].fn(picked, tok);
      if (isNum(v)) {
        if (!Number.isFinite(v)) {
          r.failed = `第 ${b} 次重抽样得到非数值结果 ${v}`;
          continue;
        }
        vals[si].push(v);
      } else {
        r.degenerate++;
        r.degenerateB.push(b);
        for (const e of v.empty) {
          const key = `${e.group}|${e.arm}`;
          r.degenerateBy[key] = (r.degenerateBy[key] ?? 0) + 1;
        }
      }
    }
  }
  res.forEach((r, si) => {
    if (r.point !== null && !Number.isFinite(r.point)) r.failed ??= `点估计为非数值 ${r.point}`;
    r.valid = vals[si].length;
    r.unstable = r.degenerate > 0;
    if (!r.failed && r.valid > 0) {
      r.lo = quantile(vals[si], 0.025);
      r.hi = quantile(vals[si], 0.975);
    }
  });
  return res;
}

// ───────────────────────────── 常用统计量 ─────────────────────────────

/** 一组观测的中位数；为空时退化 */
export function groupMedian(xs: number[], group: string, arm: string): StatValue {
  return xs.length ? median(xs) : { empty: [{ group, arm }] };
}

/** a − b；任一退化 → 合并退化信息 */
export function diff(a: StatValue, b: StatValue): StatValue {
  if (isNum(a) && isNum(b)) return a - b;
  return { empty: [...(isNum(a) ? [] : a.empty), ...(isNum(b) ? [] : b.empty)] };
}

// ───────────────────────────── 覆盖率模拟（§7.1.1–§7.1.5） ─────────────────────────────

/** §7.1.1 S1 布局：16 个有序对阵（烈刃、磐盾、森衡、紫曜 × 同序）的 G_A / G_D 观测数（C1 S1 P0 实测） */
export const S1_LAYOUT: [number, number][] = [
  [20, 0], [20, 0], [19, 0], [14, 0],
  [20, 0], [0, 0], [19, 0], [0, 11],
  [19, 0], [18, 0], [19, 0], [10, 0],
  [18, 0], [0, 10], [10, 0], [0, 1],
];

export interface SimRow {
  g: 'A' | 'D' | null;
  v: number;
}
export interface PairRow {
  g: 'A' | 'D' | null;
  v0: number;
  v1: number;
}
export interface BinRow {
  w0: number;
  w1: number;
}

type Dist = { kind: 'U'; a: number; b: number } | { kind: 'LN'; mu: number; sigma: number };

/** Box–Muller 余弦式（§7.1.5）：z = √(−2·ln(1 − u₁))·cos(2π·u₂) */
export const boxMuller = (u1: number, u2: number) => Math.sqrt(-2 * Math.log(1 - u1)) * Math.cos(2 * Math.PI * u2);

function draw(d: Dist, rnd: () => number): number {
  if (d.kind === 'U') return d.a + (d.b - d.a) * rnd();
  const u1 = rnd();
  const u2 = rnd();
  return Math.exp(d.mu + d.sigma * boxMuller(u1, u2));
}

/** 单臂用例：按布局生成各层的行（每层 perLayer 行；前 n_A 行 G_A、接着 n_D 行 G_D、其余无观测） */
export function genSingle(layout: [number, number][], perLayer: number, dA: Dist, dD: Dist, seed: number): SimRow[][] {
  const rnd = seeded(seed);
  return layout.map(([nA, nD]) => {
    const rows: SimRow[] = [];
    for (let i = 0; i < perLayer; i++) {
      if (i < nA) rows.push({ g: 'A', v: draw(dA, rnd) });
      else if (i < nA + nD) rows.push({ g: 'D', v: draw(dD, rnd) });
      else rows.push({ g: null, v: NaN });
    }
    return rows;
  });
}

/**
 * 配对连续用例（§7.1.4）：每个带观测的行取 4 个均匀数，(u₁, u₂) → Z₀，(u₃, u₄) → Z′，Z₁ = ρ·Z₀ + √(1 − ρ²)·Z′；
 * X_P0 = exp(μ_P0 + 0.5·Z₀)，X_arm = exp(μ_arm + 0.5·Z₁)。μ 按组取 ln(中位)。
 */
export function genPaired(layout: [number, number][], perLayer: number, med0: { A: number; D: number }, med1: { A: number; D: number }, rho: number, seed: number): PairRow[][] {
  const rnd = seeded(seed);
  const s = Math.sqrt(1 - rho * rho);
  return layout.map(([nA, nD]) => {
    const rows: PairRow[] = [];
    for (let i = 0; i < perLayer; i++) {
      const g = i < nA ? 'A' : i < nA + nD ? 'D' : null;
      if (!g) {
        rows.push({ g: null, v0: NaN, v1: NaN });
        continue;
      }
      const u1 = rnd();
      const u2 = rnd();
      const u3 = rnd();
      const u4 = rnd();
      const z0 = boxMuller(u1, u2);
      const zp = boxMuller(u3, u4);
      const z1 = rho * z0 + s * zp;
      rows.push({ g, v0: Math.exp(Math.log(med0[g]) + 0.5 * z0), v1: Math.exp(Math.log(med1[g]) + 0.5 * z1) });
    }
    return rows;
  });
}

/** 配对二元用例（§7.1.4）：6 层 × 20 行，每行 1 个均匀数，按 P₁₁、P₁₀、P₀₁、P₀₀ 的累积顺序决定 (W_P0, W_arm) */
export function genBinary(p0: number, p1: number, r: number, seed: number, layers = 6, perLayer = 20): BinRow[][] {
  const rnd = seeded(seed);
  const P11 = p0 * p1 + r * Math.sqrt(p0 * (1 - p0) * p1 * (1 - p1));
  const P10 = p0 - P11;
  const P01 = p1 - P11;
  if (P11 < 0 || P10 < 0 || P01 < 0 || 1 - p0 - p1 + P11 < 0) throw new Error(`二元用例不可行：p0 = ${p0}, p1 = ${p1}, r = ${r}`);
  const out: BinRow[][] = [];
  for (let h = 0; h < layers; h++) {
    const rows: BinRow[] = [];
    for (let i = 0; i < perLayer; i++) {
      const u = rnd();
      if (u < P11) rows.push({ w0: 1, w1: 1 });
      else if (u < P11 + P10) rows.push({ w0: 1, w1: 0 });
      else if (u < P11 + P10 + P01) rows.push({ w0: 0, w1: 1 });
      else rows.push({ w0: 0, w1: 0 });
    }
    out.push(rows);
  }
  return out;
}

/**
 * 同一次重抽样内按组缓存：每个组只取一次观测、只算一次中位数（仍用 m4.metrics.ts 的 median），供多个统计量共用。
 * tok（每次重抽样唯一）变化时重算。
 */
export function perResample<T>(make: (rows: never[]) => T) {
  let at = -1;
  let val: T;
  return (rows: never[], tok: number): T => {
    if (tok !== at) {
      val = make(rows);
      at = tok;
    }
    return val;
  };
}

/** Q1–Q3（单臂）的统计量 */
export function singleStats(): BootStat<SimRow>[] {
  const med = perResample((rows: never[]) => {
    const a: number[] = [];
    const d: number[] = [];
    for (const r of rows as SimRow[]) {
      if (r.g === 'A') a.push(r.v);
      else if (r.g === 'D') d.push(r.v);
    }
    return { A: groupMedian(a, 'G_A', 'arm'), D: groupMedian(d, 'G_D', 'arm') };
  });
  return [
    { name: 'Q1', fn: (rows, tok) => med(rows as never[], tok).A },
    { name: 'Q2', fn: (rows, tok) => med(rows as never[], tok).D },
    { name: 'Q3', fn: (rows, tok) => {
      const m = med(rows as never[], tok);
      return diff(m.A, m.D);
    } },
  ];
}

/** Q4：Δ_arm − Δ_P0（配对连续） */
export function pairedStat(): BootStat<PairRow>[] {
  return [
    {
      name: 'Q4',
      fn: (rows) => {
        const a0: number[] = [];
        const d0: number[] = [];
        const a1: number[] = [];
        const d1: number[] = [];
        for (const r of rows) {
          if (r.g === 'A') {
            a0.push(r.v0);
            a1.push(r.v1);
          } else if (r.g === 'D') {
            d0.push(r.v0);
            d1.push(r.v1);
          }
        }
        const delta1 = diff(groupMedian(a1, 'G_A', 'arm'), groupMedian(d1, 'G_D', 'arm'));
        const delta0 = diff(groupMedian(a0, 'G_A', 'P0'), groupMedian(d0, 'G_D', 'P0'));
        return diff(delta1, delta0);
      },
    },
  ];
}

/** Q5：胜率_臂 − 胜率_P0（配对二元；每次重抽样都有全部行，不会出现空组） */
export function binaryStat(): BootStat<BinRow>[] {
  return [
    {
      name: 'Q5',
      fn: (rows) => {
        let s0 = 0;
        let s1 = 0;
        for (const r of rows) {
          s0 += r.w0;
          s1 += r.w1;
        }
        return (s1 - s0) / rows.length;
      },
    },
  ];
}

/** §7.1.5 的用例表（c = 0–19）；真值取表中的字面值（0.04、0.03、−0.05 等），不用浮点减法结果 */
export interface SimCase {
  c: number;
  kind: 'single' | 'paired' | 'binary';
  accept: boolean;
  truth: Record<string, number>;
  gen: (seed: number) => unknown[][];
  stats: () => BootStat<never>[];
}

const S4_LAYOUT = S1_LAYOUT.map(([a, d]) => [a * 2, d * 2] as [number, number]);
const U_A: Dist = { kind: 'U', a: 0.04, b: 0.2 };
const U_D: Dist = { kind: 'U', a: 0.02, b: 0.14 };
const LN = (m: number): Dist => ({ kind: 'LN', mu: Math.log(m), sigma: 0.5 });

export function simCases(): SimCase[] {
  const cs: SimCase[] = [];
  const single = (c: number, accept: boolean, layout: [number, number][], per: number, dA: Dist, dD: Dist, t: [number, number, number]) =>
    cs.push({ c, kind: 'single', accept, truth: { Q1: t[0], Q2: t[1], Q3: t[2] }, gen: (seed) => genSingle(layout, per, dA, dD, seed), stats: singleStats as () => BootStat<never>[] });
  single(0, true, S1_LAYOUT, 20, U_A, U_D, [0.12, 0.08, 0.04]);
  single(1, true, S1_LAYOUT, 20, LN(0.12), LN(0.08), [0.12, 0.08, 0.04]);
  single(2, true, S1_LAYOUT, 20, LN(0.1), LN(0.1), [0.1, 0.1, 0]);
  single(3, false, S4_LAYOUT, 40, U_A, U_D, [0.12, 0.08, 0.04]);
  single(4, false, S4_LAYOUT, 40, LN(0.12), LN(0.08), [0.12, 0.08, 0.04]);
  single(5, false, S4_LAYOUT, 40, LN(0.1), LN(0.1), [0.1, 0.1, 0]);
  const P0 = { A: 0.12, D: 0.08 };
  const ARM = { A: 0.15, D: 0.08 };
  [0, 0.5, 0.8].forEach((rho, k) => cs.push({ c: 6 + k, kind: 'paired', accept: true, truth: { Q4: 0.03 }, gen: (seed) => genPaired(S1_LAYOUT, 20, P0, ARM, rho, seed), stats: pairedStat as () => BootStat<never>[] }));
  [0, 0.5, 0.8].forEach((rho, k) => cs.push({ c: 9 + k, kind: 'paired', accept: true, truth: { Q4: 0 }, gen: (seed) => genPaired(S1_LAYOUT, 20, P0, P0, rho, seed), stats: pairedStat as () => BootStat<never>[] }));
  [0, 0.5, 0.8].forEach((r, k) => cs.push({ c: 12 + k, kind: 'binary', accept: true, truth: { Q5: -0.05 }, gen: (seed) => genBinary(0.35, 0.3, r, seed), stats: binaryStat as () => BootStat<never>[] }));
  [0, 0.5, 0.8].forEach((r, k) => cs.push({ c: 15 + k, kind: 'binary', accept: true, truth: { Q5: 0 }, gen: (seed) => genBinary(0.35, 0.35, r, seed), stats: binaryStat as () => BootStat<never>[] }));
  [0, 0.5].forEach((r, k) => cs.push({ c: 18 + k, kind: 'binary', accept: false, truth: { Q5: -0.05 }, gen: (seed) => genBinary(0.95, 0.9, r, seed), stats: binaryStat as () => BootStat<never>[] }));
  return cs;
}

export const SIM_SEEDS = { gen: (c: number, k: number) => 71_000_000 + 10_000 * c + k, boot: (c: number, k: number) => 72_000_000 + 10_000 * c + k };
