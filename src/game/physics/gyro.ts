/**
 * 陀螺项（M4-B0，docs/engineering/m4-experiment-plan.md §4）。
 *
 * Rapier 积分刚体转动时不含陀螺项 −ω × Iω（M4-A 探针 G1：无重力自由圆盘世界系角速度不变、角动量 2 s 漂移 3.8%），
 * 所以“转得越快越稳、慢了会摇摆倒下”这类陀螺行为在引擎里只有一个惯量用错的近似。这里补上它，且对无力矩转动精确：
 *
 * 对称刚体（转轴 û，绕转轴惯量 I_a、横轴 I_t，均绕质心）的无力矩运动是两个转动的合成：
 *   绕固定的角动量方向 L̂ 以 Ω_L = |L| / I_t 转动，再加上绕自身转轴以 λ = (1 − I_a / I_t) ω_s 转动（ω_s = ω·û）。
 * 一步 dt 内的精确姿态变化 = R(L̂, Ω_L dt) ∘ R(û, λ dt)。Rapier 每步按恒定角速度转动刚体，所以
 *   - 步前（gyroStep）：把这一步的精确转动换算成等效恒定角速度 ω_eff 交给 Rapier（接触 / 关节冲量照常作用在它上面）；
 *   - 步后（gyroRecover）：真实角速度 = Ω_L L̂ + λ û_new + (步后角速度 − ω_eff)，括号里是本步接触、关节、步后冲量造成的变化。
 * 无力矩时角动量与动能逐步守恒（机器精度）；有力矩时为一阶精度（与 Rapier 本身相同）。
 * 只改“角速度怎么积分”，不施加任何额外的力、不设定朝向；默认关闭（golden 不变）。
 */

export interface V3 {
  x: number;
  y: number;
  z: number;
}

/**
 * M4-B 实验开关（默认 = 现有行为，逐位不变）：
 *  - enabled：1 = 补上陀螺项（本文件的精确转动）；
 *  - pd：1 = 保留合成自稳 PD（BeyPhysics.preStep 第 3 部分：目标倾角 + 合成进动）；0 = 去掉（B1 起）；
 *  - tiltDrive：1 = 轴心牵引方向取实际转轴相对地面法线的倾斜方向，大小再乘接地点偏移比例 min(1, sin θ_rel / sin drift)；
 *    同时暂停战术意图的进动调制（没有执行器，M4-C 再建）；0 = 现有（合成进动相位）；
 *  - flatTip：1 = 平底类轴心用圆角圆柱接地碰撞体（B2，见 FLAT_TIP），只在构造陀螺时读取；
 *  - explicitDrive：1 = 保留显式牵引冲量（现有）；0 = 去掉，牵引只来自 Rapier 接地摩擦（B2）；
 *  - scrape：1 = 保留合成刮地衰减（倾角 > 0.5 rad 的额外掉速，现有）；0 = 去掉，由刀刃 / 棘轮与地面的真实摩擦掉速（B3）。
 */
export const GYRO_EXPERIMENT = { enabled: 0, pd: 1, tiltDrive: 0, flatTip: 0, explicitDrive: 1, scrape: 1 };

/**
 * B2 接地几何：平底类轴心（平齿、橡胶）的接地碰撞体改为圆角圆柱——平底朝下、边缘倒圆，总半径 = contactRadius，
 * 倾斜后由边缘着地（接地点离转轴约 contactRadius − border），而不是用一个球近似。halfHeight / border 为形状参数（米）。
 */
export const FLAT_TIP = { halfHeight: 0.02, border: 0.03 };

/** 一台陀螺的陀螺项状态：上一步的 L̂、Ω_L、λ 与交给 Rapier 的 ω_eff */
export interface GyroState {
  lx: number;
  ly: number;
  lz: number;
  omL: number;
  lam: number;
  ex: number;
  ey: number;
  ez: number;
  valid: boolean;
}

export const emptyGyroState = (): GyroState => ({ lx: 0, ly: 1, lz: 0, omL: 0, lam: 0, ex: 0, ey: 0, ez: 0, valid: false });

interface Q {
  x: number;
  y: number;
  z: number;
  w: number;
}

function qAxis(ax: number, ay: number, az: number, ang: number): Q {
  const s = Math.sin(ang / 2);
  return { x: ax * s, y: ay * s, z: az * s, w: Math.cos(ang / 2) };
}

/** 四元数乘法 a ∘ b（先 b 后 a） */
function qMul(a: Q, b: Q): Q {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

/** 四元数 → 旋转向量（轴 × 角度，角度取 [0, π]） */
function qRotvec(q: Q): V3 {
  let { x, y, z, w } = q;
  if (w < 0) {
    x = -x;
    y = -y;
    z = -z;
    w = -w;
  }
  const s = Math.hypot(x, y, z);
  if (s < 1e-12) return { x: 2 * x, y: 2 * y, z: 2 * z };
  const ang = 2 * Math.atan2(s, w);
  return { x: (x / s) * ang, y: (y / s) * ang, z: (z / s) * ang };
}

/**
 * 步前：真实角速度 w、转轴 u（单位向量）→ 交给 Rapier 的等效恒定角速度 ω_eff（写进 st，供下一步恢复）。
 * Ia、It 绕质心；dt 物理步长。
 */
export function gyroStep(w: V3, u: V3, Ia: number, It: number, dt: number, st: GyroState): V3 {
  const ws = w.x * u.x + w.y * u.y + w.z * u.z;
  // L = I_t ω + (I_a − I_t) ω_s û
  const k = (Ia - It) * ws;
  const Lx = It * w.x + k * u.x;
  const Ly = It * w.y + k * u.y;
  const Lz = It * w.z + k * u.z;
  const Ln = Math.hypot(Lx, Ly, Lz);
  if (Ln < 1e-12) {
    st.valid = false;
    return w;
  }
  const lx = Lx / Ln;
  const ly = Ly / Ln;
  const lz = Lz / Ln;
  const omL = Ln / It;
  const lam = (1 - Ia / It) * ws;
  const q = qMul(qAxis(lx, ly, lz, omL * dt), qAxis(u.x, u.y, u.z, lam * dt));
  const rv = qRotvec(q);
  const e = { x: rv.x / dt, y: rv.y / dt, z: rv.z / dt };
  st.lx = lx;
  st.ly = ly;
  st.lz = lz;
  st.omL = omL;
  st.lam = lam;
  st.ex = e.x;
  st.ey = e.y;
  st.ez = e.z;
  st.valid = true;
  return e;
}

/** 步后：Rapier 的角速度 post（含本步接触 / 关节冲量与步后冲量）、新的转轴 u → 真实角速度 */
export function gyroRecover(post: V3, u: V3, st: GyroState): V3 {
  if (!st.valid) return post;
  return {
    x: st.omL * st.lx + st.lam * u.x + (post.x - st.ex),
    y: st.omL * st.ly + st.lam * u.y + (post.y - st.ey),
    z: st.omL * st.lz + st.lam * u.z + (post.z - st.ez),
  };
}
