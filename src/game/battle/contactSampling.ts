/**
 * 两台陀螺之间接触的观测与分类（只读：只调用 Rapier 查询，不施加任何力或冲量）。
 *
 * 分开记录、不合并成一个笼统的“接触”布尔值：
 *  - 采样状态：是否执行了 Rapier 查询；没执行的原因（两台的包围球加本步位移都够不着）；数据是否有效
 *  - 几何接触：求解器接触点的 signed distance（solverContactDist）≤ 0 —— 接触或穿透
 *  - 预测接触间隙：有求解器接触点，但最小 signed distance > 0（在 Rapier 预测距离内、尚未接触）
 *  - 冲量响应：法向接触冲量（contactImpulse）之和 > 0 —— 求解器给出了冲量，并不等于几何接触本身；
 *    零冲量也不等于没有几何接触（例如两者正在分开时的穿透）
 *  - 形状间距：Collider.contactCollider 的 ShapeContact.distance（步后位置；负数为穿透）
 *
 * Rapier 语义（rapier3d-compat 0.19.3 类型定义）：
 *  - World.contactPair(c1, c2, f(manifold, flipped))：遍历两碰撞体之间的接触流形
 *  - TempContactManifold.numSolverContacts / solverContactDist(i)：交给求解器的接触点及其 signed distance
 *  - TempContactManifold.numContacts / contactImpulse(i)：流形接触点及法向冲量
 *  - Collider.contactCollider(other, prediction)：距离超过 prediction 时返回 null
 */
import type RAPIER from '@dimforge/rapier3d-compat';

/** 一次接触采样的原始证据（各维度独立） */
export interface ContactEvidence {
  /** 是否执行了 Rapier 接触查询 */
  queried: boolean;
  /** 跳过查询的原因：'bound' = 两台包围球（加本步位移与余量）不相交，物理上不可能有接触流形 */
  skipped: 'bound' | null;
  /** 数据是否有效（只有执行了查询的步，下列字段才有意义） */
  valid: boolean;
  /** 接触流形数、流形接触点数、求解器接触点数 */
  manifolds: number;
  contacts: number;
  solverContacts: number;
  /** 求解器接触点的最小 signed distance（m）；没有求解器接触点时为 +Infinity */
  minSolverDist: number;
  /** 法向接触冲量之和（N·s）与正冲量接触点数 */
  impulse: number;
  positiveImpulseContacts: number;
  /** 两台所有碰撞体之间的最小形状距离（m，步后位置）；超过查询范围时为 +Infinity */
  shapeDistance: number;
}

/** 由原始证据得出的分类（三个维度各自独立，不互相推导） */
export interface ContactClass {
  /** 几何接触 / 穿透：有求解器接触点且最小 signed distance ≤ 0 */
  geometric: boolean;
  /** 预测接触间隙：有求解器接触点但最小 signed distance > 0 */
  predictive: boolean;
  /** 冲量响应：法向冲量之和 > 0 */
  impulseResponse: boolean;
}

export function emptyEvidence(): ContactEvidence {
  return { queried: false, skipped: null, valid: false, manifolds: 0, contacts: 0, solverContacts: 0, minSolverDist: Infinity, impulse: 0, positiveImpulseContacts: 0, shapeDistance: Infinity };
}

export function classifyContact(e: ContactEvidence): ContactClass {
  if (!e.valid) return { geometric: false, predictive: false, impulseResponse: false };
  const hasSolver = e.solverContacts > 0;
  return {
    geometric: hasSolver && e.minSolverDist <= 0,
    predictive: hasSolver && e.minSolverDist > 0,
    impulseResponse: e.impulse > 0,
  };
}

/**
 * 刚体的包围球半径：刚体原点到所有碰撞体最远点的距离（与姿态无关，倾斜时同样成立）。
 * 只认识球和圆柱（陀螺目前只用这两种）；遇到其他形状返回 +Infinity（永远查询，宁可多查不漏查）。
 */
export function boundingRadius(R: typeof RAPIER, colliders: RAPIER.Collider[]): number {
  let r = 0;
  for (const c of colliders) {
    const t = c.translationWrtParent() ?? { x: 0, y: 0, z: 0 };
    const off = Math.hypot(t.x, t.y, t.z);
    const type = c.shapeType();
    // 碰撞体自身相对父刚体的旋转只影响圆柱的朝向；用“偏移长度 + 圆柱外接球半径”覆盖任意朝向
    if (type === R.ShapeType.Ball) r = Math.max(r, off + c.radius());
    else if (type === R.ShapeType.Cylinder) r = Math.max(r, off + Math.hypot(c.radius(), c.halfHeight()));
    else return Infinity;
  }
  return r;
}

/** 形状间距查询范围（m）：超过它记为 +Infinity */
export const SHAPE_RANGE = 0.05;
/** 包围球门槛的额外余量（m），覆盖预测距离与浮点误差 */
export const BOUND_MARGIN = 0.02;

/**
 * 包围球门槛：两台刚体原点（步后）的三维距离 > 两个包围球半径 + 本步两台各自的位移上界 + 预测距离 + 余量
 * 时，本步积分前它们的碰撞体也不可能进入预测距离，Rapier 不会有接触流形，可以安全跳过查询。
 * 本步位移上界 = 步后线速度 × dt（Rapier 用求解后的速度积分位置）；绕原点的转动不改变包围球。
 */
export function canSkip(
  pa: { x: number; y: number; z: number },
  pb: { x: number; y: number; z: number },
  va: { x: number; y: number; z: number },
  vb: { x: number; y: number; z: number },
  ra: number,
  rb: number,
  dt: number,
  prediction: number,
): boolean {
  const d = Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z);
  const move = (Math.hypot(va.x, va.y, va.z) + Math.hypot(vb.x, vb.y, vb.z)) * dt;
  return d > ra + rb + move + prediction + BOUND_MARGIN;
}

/** 执行 Rapier 查询，把两台全部碰撞体对的证据写进 e（e 需先重置为 emptyEvidence 的值） */
export function queryContact(world: RAPIER.World, as: RAPIER.Collider[], bs: RAPIER.Collider[], e: ContactEvidence): void {
  e.queried = true;
  e.skipped = null;
  e.valid = true;
  for (const ca of as) {
    for (const cb of bs) {
      world.contactPair(ca, cb, (m) => {
        e.manifolds++;
        const n = m.numContacts();
        e.contacts += n;
        for (let i = 0; i < n; i++) {
          const j = m.contactImpulse(i);
          e.impulse += j;
          if (j > 0) e.positiveImpulseContacts++;
        }
        const ns = m.numSolverContacts();
        e.solverContacts += ns;
        for (let i = 0; i < ns; i++) e.minSolverDist = Math.min(e.minSolverDist, m.solverContactDist(i));
      });
      const sc = ca.contactCollider(cb, SHAPE_RANGE);
      if (sc) e.shapeDistance = Math.min(e.shapeDistance, sc.distance);
    }
  }
}
