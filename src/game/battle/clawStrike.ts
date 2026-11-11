/**
 * 重击（产品决定 D1 方案 A，代号 claw）——纯数学，不依赖 Rapier / Three.js，可在 Node 里确定性测试。
 * 设计与预注册实验：docs/engineering/m5b-experiment-plan.md §3。
 *
 * ── 物理图景 ──
 * 刀刃的爪在接触处构成倾斜的迎击面：接触法线 n* 偏离两心连线 u 一个有效倾角 ψ（朝出爪方刀刃在接触处的表面运动方向倾斜）。
 * 同向旋转的两刀刃在接触处的表面相对滑动约 2ωR（远大于平移速度），它在 n* 上的分量让两者沿 n* 闭合——
 * 按刚体碰撞（牛顿恢复系数 + 库仑摩擦）求出冲量，把一部分自转动能换成双方分离的动量。
 * Rapier 的圆柱碰撞体（刀刃外径）只能给出沿 u 的法线；这里补的是“爪面”这一部分，在物理步之后用步后速度求解。
 *
 * ── 守恒（按构造保证） ──
 *  - 冲量 J 作用在同一接触点 p：B 受 +J、A 受 −J → 两体线动量之和、对任意点的角动量之和不变；
 *  - 法向：单约束牛顿碰撞，0 ≤ e ≤ 1 → 动能变化 −(1 − e²)·v_c² / (2K) ≤ 0；
 *  - 切向：库仑摩擦 J_t = min(μ·J_n, |v_t| / K_t)，不使滑动反向 → 动能变化 ≤ 0；
 *  - 每次先用解析速度计算 ΔKE，若 ΔKE > tol × KE（数值容差）则不施加（审计；理论上永不触发）。
 * 攻击方的转速代价由 r × J 经惯量张量自然作用在角速度上，不另加扣除，也不设置任何速度。
 */

export interface V3 {
  x: number;
  y: number;
  z: number;
}

export const CLAW_EXPERIMENT = {
  /** 1 = 用重击模型替换现有咬合冲量（resolveSmash 的 jn / jt / spinLoss）；0 = 现状（默认，与 golden 逐位一致） */
  enabled: 0,
  /** 唯一的标定系数：sin ψ = kappa × bite × engage（实验臂，见预注册计划 §3.2） */
  kappa: 0.1,
  /** 能量审计的相对容差（浮点误差量级） */
  energyTol: 1e-9,
  /** sin ψ 的上限（几何上爪面不可能比 30° 更斜地迎击，防止参数误设） */
  maxSinPsi: 0.5,
};

/** 一个刚体在接触时刻的状态（世界坐标；惯量为绕质心的轴对称张量：转轴 Ia、横轴 It） */
export interface StrikeBody {
  m: number;
  c: V3;
  v: V3;
  w: V3;
  up: V3;
  Ia: number;
  It: number;
}

export interface StrikeInput {
  A: StrikeBody;
  B: StrikeBody;
  /** 接触点（世界坐标） */
  p: V3;
  /** 有效倾角正弦：A 的爪面、B 的爪面 */
  sinPsiA: number;
  sinPsiB: number;
  /** 恢复系数、摩擦系数 */
  e: number;
  mu: number;
  /** 能量审计容差（默认 CLAW_EXPERIMENT.energyTol） */
  energyTol?: number;
}

export type StrikeReason = 'ok' | 'separating' | 'energy' | 'degenerate';

export interface StrikeResult {
  applied: boolean;
  reason: StrikeReason;
  /** 作用在 B 上的总冲量（A 受 −J），作用点 = p */
  J: V3;
  jn: number;
  jt: number;
  /** 出爪方：0 = A，1 = B */
  striker: 0 | 1;
  /** 接触法线（从 A 指向 B） */
  n: V3;
  /** 闭合速度（> 0 才发生） */
  vc: number;
  /** 施加前总动能、动能变化（解析） */
  ke0: number;
  dke: number;
  /** 施加后的速度（解析预测） */
  vA: V3;
  wA: V3;
  vB: V3;
  wB: V3;
}

// ───────────── 向量工具（不分配新类型，保持纯函数） ─────────────
const v3 = (x: number, y: number, z: number): V3 => ({ x, y, z });
const add = (a: V3, b: V3): V3 => v3(a.x + b.x, a.y + b.y, a.z + b.z);
const sub = (a: V3, b: V3): V3 => v3(a.x - b.x, a.y - b.y, a.z - b.z);
const mul = (a: V3, s: number): V3 => v3(a.x * s, a.y * s, a.z * s);
const dot = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: V3, b: V3): V3 => v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const len = (a: V3): number => Math.hypot(a.x, a.y, a.z);

/** 轴对称惯量张量的逆作用在 x 上：x / It + (1/Ia − 1/It)(up·x) up */
export function invInertia(b: StrikeBody, x: V3): V3 {
  const k = (1 / b.Ia - 1 / b.It) * dot(b.up, x);
  return v3(x.x / b.It + k * b.up.x, x.y / b.It + k * b.up.y, x.z / b.It + k * b.up.z);
}

/** I·w（轴对称）：It w + (Ia − It)(up·w) up */
function inertiaTimes(b: StrikeBody, w: V3): V3 {
  const k = (b.Ia - b.It) * dot(b.up, w);
  return v3(b.It * w.x + k * b.up.x, b.It * w.y + k * b.up.y, b.It * w.z + k * b.up.z);
}

/** 一个刚体的动能：½ m v² + ½ w·I w */
export function kineticEnergy(b: StrikeBody, v: V3, w: V3): number {
  return 0.5 * b.m * dot(v, v) + 0.5 * dot(w, inertiaTimes(b, w));
}

/** 接触点的物质速度 v + w × r */
function pointVel(v: V3, w: V3, r: V3): V3 {
  return add(v, cross(w, r));
}

/** 沿单位方向 d 的有效质量倒数 K = 1/mA + 1/mB + (rA×d)·IA⁻¹(rA×d) + (rB×d)·IB⁻¹(rB×d) */
export function effectiveK(A: StrikeBody, B: StrikeBody, rA: V3, rB: V3, d: V3): number {
  const ca = cross(rA, d);
  const cb = cross(rB, d);
  return 1 / A.m + 1 / B.m + dot(ca, invInertia(A, ca)) + dot(cb, invInertia(B, cb));
}

/**
 * 爪面有效倾角的正弦：sin ψ = κ × bite × engage（上限 CLAW_EXPERIMENT.maxSinPsi）。
 *  bite = clamp(0.35 + 0.65·攻击值(出爪方) − 0.3·防御值(受击方), 0.15, 1)——沿用现有刀刃咬合描述（攻击值 = 爪的锋利程度，防御值 = 圆润刃缘的卸力）；
 *  engage = clamp((接近速度 + base) / ref, min, 1)——撞得越正咬得越深（与 SMASH_TUNING 的 engage 同一组常数，由调用方传入）。
 */
export function clawSinPsi(kappa: number, attack: number, defense: number, approach: number, eng: { base: number; ref: number; min: number }): number {
  const bite = Math.max(0.15, Math.min(1, 0.35 + 0.65 * attack - 0.3 * defense));
  const engage = Math.max(eng.min, Math.min(1, (Math.max(0, approach) + eng.base) / eng.ref));
  return Math.max(0, Math.min(CLAW_EXPERIMENT.maxSinPsi, kappa * bite * engage));
}

/** 出爪方 X 的法线（从 A 指向 B）：u 朝 X 的刀刃在接触处的表面切向运动方向倾斜 ψ（B 出爪时取反向倾斜，见文件头） */
function clawNormal(u: V3, surf: V3, sinPsi: number, sign: 1 | -1): V3 | null {
  // 表面运动的水平切向分量（去掉沿 u 的分量与竖直分量）
  const h = v3(surf.x, 0, surf.z);
  const t = sub(h, mul(u, dot(h, u)));
  const tl = len(t);
  if (tl < 1e-9 || sinPsi <= 0) return u;
  const cs = Math.sqrt(Math.max(0, 1 - sinPsi * sinPsi));
  const n = add(mul(u, cs), mul(t, (sign * sinPsi) / tl));
  const nl = len(n);
  return nl > 1e-12 ? mul(n, 1 / nl) : null;
}

/** 求解一次重击（不施加；返回冲量与预测的速度，由调用方用 Rapier 的 applyImpulseAtPoint 在 p 点成对施加） */
export function solveStrike(inp: StrikeInput): StrikeResult {
  const { A, B, p, e, mu } = inp;
  const tol = inp.energyTol ?? CLAW_EXPERIMENT.energyTol;
  const none = (reason: StrikeReason, n: V3 = v3(1, 0, 0), vc = 0, striker: 0 | 1 = 0): StrikeResult => ({
    applied: false,
    reason,
    J: v3(0, 0, 0),
    jn: 0,
    jt: 0,
    striker,
    n,
    vc,
    ke0: kineticEnergy(A, A.v, A.w) + kineticEnergy(B, B.v, B.w),
    dke: 0,
    vA: A.v,
    wA: A.w,
    vB: B.v,
    wB: B.w,
  });
  const du = v3(B.c.x - A.c.x, 0, B.c.z - A.c.z);
  const dl = len(du);
  if (dl < 1e-9) return none('degenerate');
  const u = mul(du, 1 / dl);
  const rA = sub(p, A.c);
  const rB = sub(p, B.c);
  const vrel0 = sub(pointVel(A.v, A.w, rA), pointVel(B.v, B.w, rB));
  // 两个候选：A 的爪面（朝 A 表面运动方向倾斜）、B 的爪面（朝 B 表面运动方向倾斜，作为 A→B 法线即反向倾斜）
  const nA = clawNormal(u, cross(A.w, rA), inp.sinPsiA, 1);
  const nB = clawNormal(u, cross(B.w, rB), inp.sinPsiB, -1);
  if (!nA || !nB) return none('degenerate');
  const vcA = dot(vrel0, nA);
  const vcB = dot(vrel0, nB);
  const striker: 0 | 1 = vcB > vcA ? 1 : 0;
  const n = striker === 0 ? nA : nB;
  const vc = striker === 0 ? vcA : vcB;
  if (!(vc > 0)) return none('separating', n, vc, striker);

  // 法向：牛顿碰撞
  const K = effectiveK(A, B, rA, rB, n);
  const jn = ((1 + Math.max(0, Math.min(1, e))) * vc) / K;
  const Jn = mul(n, jn);
  const vA1 = sub(A.v, mul(Jn, 1 / A.m));
  const wA1 = sub(A.w, invInertia(A, cross(rA, Jn)));
  const vB1 = add(B.v, mul(Jn, 1 / B.m));
  const wB1 = add(B.w, invInertia(B, cross(rB, Jn)));
  // 切向：库仑摩擦，不使滑动反向
  const vrel1 = sub(pointVel(vA1, wA1, rA), pointVel(vB1, wB1, rB));
  const vt = sub(vrel1, mul(n, dot(vrel1, n)));
  const vtl = len(vt);
  let jt = 0;
  let J = Jn;
  if (vtl > 1e-9 && mu > 0) {
    const t = mul(vt, 1 / vtl);
    const Kt = effectiveK(A, B, rA, rB, t);
    jt = Math.min(mu * jn, vtl / Kt);
    J = add(Jn, mul(t, jt));
  }
  // 施加总冲量后的速度（B 受 +J，A 受 −J，作用点 p）
  const vA = sub(A.v, mul(J, 1 / A.m));
  const wA = sub(A.w, invInertia(A, cross(rA, J)));
  const vB = add(B.v, mul(J, 1 / B.m));
  const wB = add(B.w, invInertia(B, cross(rB, J)));
  const ke0 = kineticEnergy(A, A.v, A.w) + kineticEnergy(B, B.v, B.w);
  const ke1 = kineticEnergy(A, vA, wA) + kineticEnergy(B, vB, wB);
  const dke = ke1 - ke0;
  if (dke > tol * ke0 + 1e-12) return { ...none('energy', n, vc, striker), dke };
  return { applied: true, reason: 'ok', J, jn, jt, striker, n, vc, ke0, dke, vA, wA, vB, wB };
}
