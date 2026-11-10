import { describe, expect, it } from 'vitest';
import { clawSinPsi, kineticEnergy, solveStrike, type StrikeBody, type StrikeInput, type V3 } from '../src/game/battle/clawStrike';

/**
 * 重击模型（D1 方案 A）的物理约束测试：纯数学，不依赖 Rapier。
 * 守恒：线动量、对任意点的角动量；动能不增；不在分离时施加；无摩擦时满足牛顿恢复定律。
 */

const ENG = { base: 0.4, ref: 5, min: 0.35 };
const v3 = (x: number, y: number, z: number): V3 => ({ x, y, z });
const dot = (a: V3, b: V3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: V3, b: V3): V3 => v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const sub = (a: V3, b: V3): V3 => v3(a.x - b.x, a.y - b.y, a.z - b.z);
const add = (a: V3, b: V3): V3 => v3(a.x + b.x, a.y + b.y, a.z + b.z);
const mul = (a: V3, s: number): V3 => v3(a.x * s, a.y * s, a.z * s);
const norm = (a: V3): V3 => mul(a, 1 / Math.hypot(a.x, a.y, a.z));

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 两台陀螺并排（A 在 −x，B 在 +x），默认都右旋 140 rad/s、直立、A 以 3 u/s 接近 */
function scene(o: Partial<{ wA: number; wB: number; vA: V3; vB: V3; upA: V3; upB: V3; sinA: number; sinB: number; e: number; mu: number }> = {}): StrikeInput {
  const A: StrikeBody = { m: 4.4, c: v3(-0.52, 0.42, 0), v: o.vA ?? v3(3, 0, 0), w: mul(o.upA ?? v3(0, 1, 0), o.wA ?? -140), up: o.upA ?? v3(0, 1, 0), Ia: 0.46, It: 0.26 };
  const B: StrikeBody = { m: 5.1, c: v3(0.5, 0.4, 0), v: o.vB ?? v3(0, 0, 0), w: mul(o.upB ?? v3(0, 1, 0), o.wB ?? -140), up: o.upB ?? v3(0, 1, 0), Ia: 0.6, It: 0.33 };
  return { A, B, p: v3(0, 0.45, 0), sinPsiA: o.sinA ?? 0.05, sinPsiB: o.sinB ?? 0.02, e: o.e ?? 0.19, mu: o.mu ?? 0.275 };
}

function linMomentum(inp: StrikeInput, vA: V3, vB: V3): V3 {
  return add(mul(vA, inp.A.m), mul(vB, inp.B.m));
}
function iw(b: StrikeBody, w: V3): V3 {
  const k = (b.Ia - b.It) * dot(b.up, w);
  return add(mul(w, b.It), mul(b.up, k));
}
/** 对点 o 的角动量：Σ (c − o) × m v + I w */
function angMomentum(inp: StrikeInput, o: V3, vA: V3, wA: V3, vB: V3, wB: V3): V3 {
  return add(add(cross(sub(inp.A.c, o), mul(vA, inp.A.m)), iw(inp.A, wA)), add(cross(sub(inp.B.c, o), mul(vB, inp.B.m)), iw(inp.B, wB)));
}

function randomScene(r: () => number): StrikeInput {
  const tilt = (s: number) => norm(v3((r() - 0.5) * s, 1, (r() - 0.5) * s));
  const upA = tilt(0.8);
  const upB = tilt(0.8);
  const sgnA = r() < 0.85 ? -1 : 1;
  const sgnB = r() < 0.85 ? -1 : 1;
  const extra = () => v3((r() - 0.5) * 8, (r() - 0.5) * 4, (r() - 0.5) * 8);
  const A: StrikeBody = { m: 3 + r() * 3, c: v3(-0.5 - r() * 0.1, 0.3 + r() * 0.2, (r() - 0.5) * 0.2), v: v3((r() - 0.3) * 10, (r() - 0.5) * 2, (r() - 0.5) * 10), w: add(mul(upA, sgnA * (5 + r() * 160)), extra()), up: upA, Ia: 0.3 + r() * 0.5, It: 0.15 + r() * 0.4 };
  const B: StrikeBody = { m: 3 + r() * 3, c: v3(0.5 + r() * 0.1, 0.3 + r() * 0.2, (r() - 0.5) * 0.2), v: v3((r() - 0.7) * 10, (r() - 0.5) * 2, (r() - 0.5) * 10), w: add(mul(upB, sgnB * (5 + r() * 160)), extra()), up: upB, Ia: 0.3 + r() * 0.5, It: 0.15 + r() * 0.4 };
  return { A, B, p: v3((r() - 0.5) * 0.1, 0.35 + r() * 0.2, (r() - 0.5) * 0.2), sinPsiA: r() * 0.5, sinPsiB: r() * 0.5, e: r(), mu: r() };
}

describe('重击模型（D1 方案 A）：物理约束（纯数学）', () => {
  it('守恒：线动量、对任意点的角动量在 3000 个随机接触状态下都不变（同一点、等大反向）', () => {
    const r = rng(20261111);
    let applied = 0;
    for (let i = 0; i < 3000; i++) {
      const inp = randomScene(r);
      const s = solveStrike(inp);
      if (!s.applied) continue;
      applied++;
      const p0 = linMomentum(inp, inp.A.v, inp.B.v);
      const p1 = linMomentum(inp, s.vA, s.vB);
      const scaleP = Math.hypot(p0.x, p0.y, p0.z) + Math.hypot(s.J.x, s.J.y, s.J.z) + 1;
      expect(Math.hypot(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z) / scaleP).toBeLessThan(1e-12);
      for (const o of [v3(0, 0, 0), v3(3, -1, 2)]) {
        const L0 = angMomentum(inp, o, inp.A.v, inp.A.w, inp.B.v, inp.B.w);
        const L1 = angMomentum(inp, o, s.vA, s.wA, s.vB, s.wB);
        const scaleL = Math.hypot(L0.x, L0.y, L0.z) + 1;
        expect(Math.hypot(L1.x - L0.x, L1.y - L0.y, L1.z - L0.z) / scaleL).toBeLessThan(1e-11);
      }
    }
    expect(applied).toBeGreaterThan(1000);
  });

  it('动能不增：3000 个随机状态下 ΔKE ≤ 0（容差 1e−9 相对），能量审计从不拒绝', () => {
    const r = rng(7);
    let applied = 0;
    let rejected = 0;
    let worst = -Infinity;
    for (let i = 0; i < 3000; i++) {
      const inp = randomScene(r);
      const s = solveStrike(inp);
      if (s.reason === 'energy') rejected++;
      if (!s.applied) continue;
      applied++;
      const ke0 = kineticEnergy(inp.A, inp.A.v, inp.A.w) + kineticEnergy(inp.B, inp.B.v, inp.B.w);
      const ke1 = kineticEnergy(inp.A, s.vA, s.wA) + kineticEnergy(inp.B, s.vB, s.wB);
      worst = Math.max(worst, (ke1 - ke0) / ke0);
      expect(ke1).toBeLessThanOrEqual(ke0 * (1 + 1e-9));
    }
    expect(applied).toBeGreaterThan(1000);
    expect(rejected).toBe(0);
    expect(worst).toBeLessThanOrEqual(1e-9);
  });

  it('只在闭合时发生：接触点正在分离（v_c ≤ 0）不施加任何冲量', () => {
    // 不转、正在分开
    const s = solveStrike(scene({ wA: 0, wB: 0, vA: v3(-2, 0, 0), vB: v3(2, 0, 0) }));
    expect(s.applied).toBe(false);
    expect(s.reason).toBe('separating');
    expect(s.jn).toBe(0);
  });

  it('无摩擦时满足牛顿恢复定律：施加后沿法线的相对速度 = −e × 施加前', () => {
    for (const e of [0, 0.19, 0.5, 1]) {
      const inp = scene({ e, mu: 0 });
      const s = solveStrike(inp);
      expect(s.applied).toBe(true);
      const rA = sub(inp.p, inp.A.c);
      const rB = sub(inp.p, inp.B.c);
      const vrel = sub(add(s.vA, cross(s.wA, rA)), add(s.vB, cross(s.wB, rB)));
      expect(dot(vrel, s.n)).toBeCloseTo(-e * s.vc, 9);
    }
  });

  it('倾角为 0、不转、正面相撞：退化为普通碰撞（法线沿两心连线，冲量 = (1+e)·μ_red·v）', () => {
    const inp = scene({ wA: 0, wB: 0, sinA: 0, sinB: 0, mu: 0, e: 0.3 });
    const s = solveStrike(inp);
    expect(s.applied).toBe(true);
    expect(s.n.x).toBeCloseTo(1, 12);
    // 直立、接触点与质心几乎等高，转动项很小：J ≈ (1+e) × v / (1/mA + 1/mB)
    const red = 1 / (1 / inp.A.m + 1 / inp.B.m);
    expect(s.jn / ((1 + 0.3) * 3 * red)).toBeGreaterThan(0.9);
    expect(s.jn / ((1 + 0.3) * 3 * red)).toBeLessThanOrEqual(1);
  });

  it('同向旋转：两方的爪面都把法线朝同一侧倾斜；出爪越斜，闭合速度与冲量越大', () => {
    let last = 0;
    for (const sin of [0.01, 0.03, 0.06, 0.12, 0.2]) {
      const s = solveStrike(scene({ sinA: sin, sinB: 0, mu: 0 }));
      expect(s.applied).toBe(true);
      expect(s.jn).toBeGreaterThan(last);
      last = s.jn;
    }
    const a = solveStrike(scene({ sinA: 0.1, sinB: 0 }));
    const b = solveStrike(scene({ sinA: 0, sinB: 0.1 }));
    // 法线的切向分量同号（右旋：A 在接触处的表面朝 +z 运动，B 朝 −z，两方的爪面都让法线朝 +z 倾斜）
    expect(Math.sign(a.n.z)).toBe(Math.sign(b.n.z));
    expect(a.n.z).not.toBe(0);
  });

  it('转速代价来自角冲量：两台都掉速，掉速量 = 冲量对转轴的力矩 / 轴向惯量（没有额外扣除）', () => {
    const inp = scene({ mu: 0 });
    const s = solveStrike(inp);
    expect(s.applied).toBe(true);
    const spinA0 = Math.abs(dot(inp.A.w, inp.A.up));
    const spinA1 = Math.abs(dot(s.wA, inp.A.up));
    const spinB1 = Math.abs(dot(s.wB, inp.B.up));
    expect(spinA1).toBeLessThan(spinA0);
    expect(spinB1).toBeLessThan(140);
    // 直立：Δω_A·ŷ = −(r_A × (−J))·ŷ / Ia
    const rA = sub(inp.p, inp.A.c);
    const tq = cross(rA, mul(s.J, -1));
    expect(dot(s.wA, inp.A.up) - dot(inp.A.w, inp.A.up)).toBeCloseTo(tq.y / inp.A.Ia, 9);
  });

  it('镜像对称：把场景沿 x 镜像并交换双方，冲量大小不变', () => {
    const inp = scene({ wA: -140, wB: -140, sinA: 0.08, sinB: 0.08, vA: v3(3, 0, 0), vB: v3(0, 0, 0) });
    const s = solveStrike(inp);
    // 镜像：x → −x 后右旋变为左旋（角速度是轴向量：w → (wx, −wy, −wz)… 对竖直转轴即 wy → −wy）
    const mir = (b: StrikeBody): StrikeBody => ({ ...b, c: v3(-b.c.x, b.c.y, b.c.z), v: v3(-b.v.x, b.v.y, b.v.z), w: v3(b.w.x, -b.w.y, -b.w.z) });
    const m: StrikeInput = { ...inp, A: mir(inp.B), B: mir(inp.A), p: v3(-inp.p.x, inp.p.y, inp.p.z), sinPsiA: inp.sinPsiB, sinPsiB: inp.sinPsiA };
    const t = solveStrike(m);
    expect(t.applied).toBe(true);
    expect(t.jn).toBeCloseTo(s.jn, 9);
    expect(t.jt).toBeCloseTo(s.jt, 9);
  });

  it('爪面倾角：攻击值越高 / 接近越快越斜，防御值越高越缓；有上下限', () => {
    expect(clawSinPsi(0.1, 0.9, 0.25, 3, ENG)).toBeGreaterThan(clawSinPsi(0.1, 0.35, 0.25, 3, ENG));
    expect(clawSinPsi(0.1, 0.9, 0.7, 3, ENG)).toBeLessThan(clawSinPsi(0.1, 0.9, 0.25, 3, ENG));
    expect(clawSinPsi(0.1, 0.9, 0.25, 5, ENG)).toBeGreaterThan(clawSinPsi(0.1, 0.9, 0.25, 0.5, ENG));
    expect(clawSinPsi(0, 0.9, 0.25, 5, ENG)).toBe(0);
    expect(clawSinPsi(10, 1, 0, 10, ENG)).toBe(0.5);
    // 贴身（接近速度 0）仍有最小咬合
    expect(clawSinPsi(0.1, 0.9, 0.25, 0, ENG)).toBeCloseTo(0.1 * Math.min(1, 0.35 + 0.585 - 0.075) * 0.35, 12);
  });
});
