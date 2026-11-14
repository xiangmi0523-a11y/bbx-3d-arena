/**
 * M4-C · C2-P 统计工具（纯函数、无依赖）：互补误差函数与 McNemar 检验。
 * 规范：docs/engineering/m4c-c2-preregistration.md §7.1.7（冻结于 1aab164）。测试：tests/c2pStats.test.ts。
 *
 * erfc 的实现（文献可查，双精度）：
 *  - 0 ≤ x < 2.5：erfc x = 1 − erf x，erf 用 Abramowitz & Stegun (1964) 式 7.1.6 的正项级数
 *      erf x = (2/√π)·e^(−x²)·Σ_{n≥0} 2ⁿ·x^(2n+1) / (1·3·5···(2n+1))，
 *    各项为正、无相消，累加到项相对和 < 1e−17；
 *  - x ≥ 2.5：A&S 式 7.1.14 的连分式
 *      erfc x = (e^(−x²)/√π) · 1 / (x + (1/2) / (x + 1 / (x + (3/2) / (x + 2 / (x + …)))))，
 *    自下而上取 120 层（x ≥ 2.5 时已远超双精度收敛所需）；
 *  - x < 0：erfc x = 2 − erfc(−x)。
 * 卡方（自由度 1）上尾概率 P(χ²₁ ≥ q) = erfc(√(q/2))（§7.1.7）。
 */

const SQRT_PI = Math.sqrt(Math.PI);

export function erfc(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (x < 0) return 2 - erfc(-x);
  if (x === Infinity) return 0;
  if (x < 2.5) {
    const x2 = x * x;
    let term = x;
    let sum = x;
    for (let n = 1; n < 400; n++) {
      term *= (2 * x2) / (2 * n + 1);
      sum += term;
      if (term < sum * 1e-17) break;
    }
    return 1 - (2 / SQRT_PI) * Math.exp(-x2) * sum;
  }
  // 连分式 x + (k/2) / (x + ((k+1)/2) / …)，自下而上
  let t = x;
  for (let k = 120; k >= 1; k--) t = x + k / 2 / t;
  return Math.exp(-x * x) / SQRT_PI / t;
}

/** 自由度 1 的卡方分布上尾概率 */
export const chi2SfDf1 = (q: number): number => erfc(Math.sqrt(q / 2));

export type McNemar =
  | { applicable: true; b: number; c: number; chi2: number; p: number; chi2cc: number; pcc: number }
  | { applicable: false; b: 0; c: 0; note: string };

/**
 * McNemar 检验（§7.1.7）：b = P0 为 1、候选臂为 0 的配对数，c = P0 为 0、候选臂为 1 的配对数。
 * b + c = 0 时不计算统计量（不是统计分析失败，也不作判定）。
 */
export function mcnemar(b: number, c: number): McNemar {
  if (!(Number.isInteger(b) && Number.isInteger(c) && b >= 0 && c >= 0)) throw new Error(`McNemar 输入必须是非负整数：b = ${b}, c = ${c}`);
  if (b + c === 0) return { applicable: false, b: 0, c: 0, note: 'b = c = 0，无不一致配对，McNemar 不适用' };
  const chi2 = (b - c) ** 2 / (b + c);
  const chi2cc = Math.max(0, Math.abs(b - c) - 1) ** 2 / (b + c);
  return { applicable: true, b, c, chi2, p: chi2SfDf1(chi2), chi2cc, pcc: chi2SfDf1(chi2cc) };
}
