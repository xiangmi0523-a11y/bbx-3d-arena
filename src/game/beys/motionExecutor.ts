/**
 * M4-C · C0 运动执行层（docs/engineering/m4c-route-decision.md §1、§10；Huang 2026-11-12 授权：零行为变化拆分）。
 *
 * 从 BeyPhysics.preStep 拆出的四个阶段：轨道冲刺、轴心牵引、滚动阻力、姿态（自稳 PD + 进动）。
 * 拆分规则（C0 验收条件）：
 *  - 按原 preStep 的顺序**分段调用**：每个阶段在原来的位置被调用，自己从刚体读取新鲜状态（例如牵引读取的线速度已经包含
 *    本步轨道冲刺冲量，滚动阻力读取的线速度已经包含牵引冲量），并在原位置立即施加作用——不是“一次快照、最后统一施加”；
 *  - 各阶段的算式、取值顺序与原代码逐字一致，因此结果逐位相同（golden 180 场 + 旧路径对照 + 逐调用序列测试）；
 *  - 旧路径 BeyPhysics.preStepLegacy 原样保留，EXECUTOR_SWITCH.legacy = 1 时整体切回（回滚开关）。
 *
 * 新增参数一律放在 EXECUTOR_TUNING（独立对象，不进 BEY_TUNING / 参数指纹）；C0 不引入任何影响行为的参数。
 *
 * 接地法向力 N（只读，C0 不参与任何计算）：每个物理子步的 preStep 开始时，从 ContactService 读取“本台轴心 ↔ 场地地面”
 * 碰撞体对在**上一子步**求解后匹配到的法向冲量 J，N = J / dt。ContactService.observe 在上一子步 world.step 之后运行，
 * 所以这是滞后一拍的量（step 字段记录它来自哪一次 observe）；第一步、没有接触观测、或不在对局里时 valid = false。
 */
import type RAPIER from '@dimforge/rapier3d-compat';
import { ARENA, floorNormal } from '../arena/arenaSpec';
import type { GYRO_EXPERIMENT } from '../physics/gyro';
import type { ContactService } from '../physics/ContactService';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import type { MotionIntent } from './motionIntent';
import type { AssembledBey } from './parts/assemble';

/** 回滚开关：1 = 走原样保留的旧 preStep（BeyPhysics.preStepLegacy）；0 = 走分段执行层（默认）。两条路径逐位等价 */
export const EXECUTOR_SWITCH = { legacy: 0 };

/** 执行层参数（独立于 BEY_TUNING，不进参数指纹）。C0 为零行为变化拆分，没有新参数 */
export const EXECUTOR_TUNING: Record<string, number> = {};

/** 执行层读取的陀螺状态（BeyPhysics 实现；只在执行层的阶段函数里读写） */
export interface ExecutorHost {
  readonly body: RAPIER.RigidBody;
  readonly spec: AssembledBey;
  readonly launchSpin: number;
  readonly spinSign: number;
  readonly intent: MotionIntent;
  readonly opponent: ExecutorHost | null;
  readonly breakout: number;
  readonly bursted: boolean;
  readonly grounded: boolean;
  readonly tilt: number;
  readonly gyroFactor: number;
  readonly launchHeading: number;
  readonly pw: PhysicsWorld;
  precession: number;
  dashing: boolean;
  knocked: boolean;
  knockResyncs: number;
}

/** 一个物理子步内各阶段共用的局部量（原 preStep 的局部变量，按原顺序被读写；对象复用，不分配） */
export interface ExecFrame {
  dt: number;
  G: typeof GYRO_EXPERIMENT;
  up: { x: number; y: number; z: number };
  pos: { x: number; y: number; z: number };
  r: number;
  mag: number;
  decay: number;
  lRail: number;
  lDrive: number;
  lSteer: number;
  steering: number;
  px: number;
  py: number;
  pz: number;
}

export const newExecFrame = (G: typeof GYRO_EXPERIMENT): ExecFrame => ({
  dt: 0,
  G,
  up: { x: 0, y: 1, z: 0 },
  pos: { x: 0, y: 0, z: 0 },
  r: 0,
  mag: 0,
  decay: 0,
  lRail: 0,
  lDrive: 0,
  lSteer: 0,
  steering: 0,
  px: 0,
  py: 0,
  pz: 0,
});

/** 只读的接地法向力样本（上一子步） */
export interface LoadSample {
  /** 是否有可用的观测（对局中、ContactService 已观测过至少一步） */
  valid: boolean;
  /** 上一子步匹配到的轴心-地面法向冲量之和（N·s） */
  impulse: number;
  /** N = impulse / dt（dt = 上一子步时长 = PhysicsWorld.stepDt） */
  N: number;
  /** 这份数据来自 ContactService 第几次 observe（= 上一子步）；无效时 −1 */
  step: number;
  /** 读取时 ContactService 的接触对数据状态（'ok' / 'match-incomplete' / 'none'） */
  status: string;
}

export const newLoadSample = (): LoadSample => ({ valid: false, impulse: 0, N: 0, step: -1, status: 'none' });

/**
 * 读取上一子步的接地法向力（只读，不改任何状态）。owner = ContactService 里的主体名（'player' / 'rival'），
 * 由 BattleSystem 在创建陀螺时写入；没有 owner 或没有接触观测时 valid = false。
 */
export function readTipLoad(cs: ContactService | null, owner: string | null, stepDt: number, out: LoadSample): LoadSample {
  if (!cs || !owner || cs.step <= 0) {
    out.valid = false;
    out.impulse = 0;
    out.N = 0;
    out.step = -1;
    out.status = 'none';
    return out;
  }
  const p = cs.colliderPair(`${owner}:bit`, 'arena:floor');
  out.valid = true;
  out.step = cs.step;
  out.impulse = p && p.seenStep === cs.step ? p.normalImpulse : 0;
  out.status = p ? p.dataStatus : 'none';
  out.N = out.impulse / stepDt;
  return out;
}

/** 阶段 2：极限轨道——齿轮轴心咬合轨道冲刺（原 preStep 第 2 部分，逐字移入） */
export function stepRail(h: ExecutorHost, f: ExecFrame, T: RailTuning): void {
  const body = h.body;
  const pos = f.pos;
  const r = f.r;
  const mag = f.mag;
  const dt = f.dt;
  h.dashing = false;
  const grip = h.spec.bit.gearGrip;
  // 齿轮门控（R8）：冲刺资格来自齿轮，强度不随抓地力缩放
  const gearOnly = T.railGearOnly > 0;
  const canDash = gearOnly ? h.spec.bit.gear : grip > 0;
  const dashK = gearOnly ? 1 : grip;
  if (!h.bursted && canDash && h.grounded && r > ARENA.railInner && r < ARENA.railOuter + 0.05 && mag > T.minStableSpin) {
    const ex = pos.x / r;
    const ez = pos.z / r;
    // ω × e_r 的水平分量（ω 竖直），冲刺方向为其反方向（齿轮在外圈齿条上滚动）
    const wy = h.spinSign * mag;
    // 轨道末端带一点向内的分量，让冲刺把陀螺“甩”回场地中央（Xtreme 冲刺的观感）
    let dx = -(wy * ez) / Math.max(1e-6, Math.abs(wy)) - ex * T.railInward;
    let dz = (wy * ex) / Math.max(1e-6, Math.abs(wy)) - ez * T.railInward;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    const v = body.linvel();
    const along = v.x * dx + v.z * dz;
    if (along < T.railMaxSpeed) {
      const accel = T.railDash * dashK * Math.min(1, mag / (h.launchSpin * 0.4));
      const m = body.mass();
      body.applyImpulse({ x: dx * accel * m * dt, y: 0, z: dz * accel * m * dt }, true);
      f.decay += T.railSpinCost * dashK;
      f.lRail = T.railSpinCost * dashK;
      h.dashing = true;
    }
  }
}

/** 阶段 3：轴心牵引（花瓣轨迹）+ 转向代价（原 preStep 牵引段，逐字移入） */
export function stepTraction(h: ExecutorHost, f: ExecFrame, T: TractionTuning): void {
  const body = h.body;
  const G = f.G;
  const up = f.up;
  const pos = f.pos;
  const r = f.r;
  const mag = f.mag;
  const dt = f.dt;
  const opp = h.opponent;
  const grip = h.spec.bit.gearGrip;
  // 轴心牵引（花瓣轨迹）：方向垂直于当前倾斜方向，随进动旋转。
  // 方向只由进动相位决定；战术意图通过调节相位转速间接影响它（见姿态阶段）。
  // 脱困时针尖这类几乎没有牵引的轴心也按 breakoutGrip 计算（低转速晃动时轴心与碗面接触点外移，能“走”起来）
  let driveGrip = h.breakout > 0 ? Math.max(grip, T.breakoutGrip) : grip;
  // 墙边：没有牵引的轴心（针尖）贴近外圈时，与脱困同理按 edgeGrip 计算牵引（倾斜着压在陡坡上，接触点外移）
  if (T.edgeGrip > 0 && h.intent.edgeW > 0) driveGrip = Math.max(driveGrip, T.edgeGrip * Math.min(1, h.intent.edgeW * 2));
  let steering = 0;
  if (!h.bursted && driveGrip >= T.driveMinGrip && h.grounded && !h.dashing && mag > T.minStableSpin * 2) {
    const ratio = Math.min(1, mag / h.launchSpin);
    const v = body.linvel();
    let dx = -Math.sin(h.precession) * h.spinSign;
    let dz = Math.cos(h.precession) * h.spinSign;
    // 实验（GYRO_EXPERIMENT.tiltDrive）：牵引方向取实际转轴相对地面法线的倾斜方向，大小按接地点偏移比例缩放
    let driveScale = 1;
    if (G.tiltDrive > 0) {
      const n = r <= ARENA.radius ? floorNormal(pos.x, pos.z) : [0, 1, 0];
      const d = up.x * n[0] + up.y * n[1] + up.z * n[2];
      const tx = up.x - d * n[0];
      const ty = up.y - d * n[1];
      const tz = up.z - d * n[2];
      const sinRel = Math.hypot(tx, ty, tz);
      if (sinRel > 1e-6) {
        const phi = Math.atan2(tz, tx);
        dx = -Math.sin(phi) * h.spinSign;
        dz = Math.cos(phi) * h.spinSign;
      }
      driveScale = Math.min(1, sinRel / Math.max(1e-3, Math.sin(h.spec.bit.drift)));
    }
    // 脱困（P2.3.1 辅助机制，保持原样）：牵引方向背离对手并偏开 runupAngle，靠外圈时不朝墙
    if (h.breakout > 0 && opp) {
      const op = opp.body.translation();
      const ox = op.x - pos.x;
      const oz = op.z - pos.z;
      const ol = Math.hypot(ox, oz);
      if (ol > 1e-3) {
        const c = Math.cos(T.runupAngle);
        const sn = Math.sin(T.runupAngle) * h.spinSign;
        const ax = -ox / ol;
        const az = -oz / ol;
        let gx = ax * c - az * sn;
        let gz = ax * sn + az * c;
        if (r > T.backoffEdge) {
          const ex = pos.x / r;
          const ez = pos.z / r;
          const out = gx * ex + gz * ez;
          if (out > 0) {
            const w = Math.min(1, (r - T.backoffEdge) / 1.5);
            gx -= ex * out * w;
            gz -= ez * out * w;
          }
        }
        const gl = Math.hypot(gx, gz) || 1;
        dx = gx / gl;
        dz = gz / gl;
      }
    }
    steering = h.breakout > 0 || G.tiltDrive > 0 ? 0 : h.intent.authority;
    const along = v.x * dx + v.z * dz;
    // 借来的墙边咬合（轴心本身没有牵引）只在牵引方向与墙边修正方向夹角 < 90° 时起作用：
    // 否则针尖会在外圈获得随相位乱转的推力，越转越快（实测耐力型游走从 1 m/s 加速到 6 m/s 沿墙绕）
    const edgeOnly = h.breakout <= 0 && grip < T.driveMinGrip;
    const edgeHelps = !edgeOnly || dx * Math.cos(h.intent.heading) + dz * Math.sin(h.intent.heading) > 0;
    if (G.explicitDrive > 0 && edgeHelps && along < T.driveSpeed * driveGrip * (0.35 + 0.65 * (h.breakout > 0 ? Math.max(ratio, T.breakoutRatio) : ratio))) {
      // 脱困（辅助机制）：低转速的球头 / 针尖轴心牵引很弱，停在碗底会一直原地互转。
      // 僵持一段时间后，按“至少 breakoutRatio 的转速、breakoutGrip 的咬合度”给 0.7 秒牵引，方向背离对手；
      // 力的大小仍按轴心牵引公式与速度上限计算，拉开后由碗面重力拉回、真实碰撞
      const r2 = h.breakout > 0 ? Math.max(ratio, T.breakoutRatio) : ratio;
      const a = T.driveAccel * driveGrip * r2 * body.mass() * dt * driveScale;
      body.applyImpulse({ x: dx * a, y: 0, z: dz * a }, true);
      f.decay += T.driveSpinCost * driveGrip;
      f.lDrive = T.driveSpinCost * driveGrip;
    }
    // 改变轴的倾斜方向需要力矩：按调制深度额外消耗转速
    f.decay += T.steerSpinCost * steering * driveGrip;
    f.lSteer = T.steerSpinCost * steering * driveGrip;
  }
  f.steering = steering;
}

/** 阶段 4：轴心滚动 / 滑动阻力（原 preStep 滚动阻力段，逐字移入） */
export function stepRolling(h: ExecutorHost, f: ExecFrame, T: RollingTuning): void {
  // 轴心滚动 / 滑动阻力：在碗面上持续损失水平速度，绕圈的陀螺会慢慢滑回中央与对手相遇
  if (h.grounded) {
    const body = h.body;
    const v = body.linvel();
    const sp = Math.hypot(v.x, v.z);
    if (sp > 1e-3) {
      const dv = Math.min(sp, (T.rollBase + T.rollFriction * h.spec.bit.friction) * h.pw.g * f.dt);
      const m = body.mass();
      body.applyImpulse({ x: (-v.x / sp) * dv * m, y: 0, z: (-v.z / sp) * dv * m }, true);
    }
  }
}

/** 阶段 5：陀螺仪自稳（PD）+ 进动相位（原 preStep 第 3 部分，逐字移入）。改写 f.px / f.py / f.pz 与 h.precession */
export function stepPosture(h: ExecutorHost, f: ExecFrame, T: PostureTuning): void {
  const G = f.G;
  const up = f.up;
  const mag = f.mag;
  const dt = f.dt;
  const steering = f.steering;
  // 3) 陀螺仪自稳：转得越快越能保持直立；角动量 L = Iω 越大越难被撞歪（防御 / 耐力型更稳）
  const s = Math.max(0, Math.min(1, (mag - T.minStableSpin) / (h.launchSpin * 0.3))) * h.gyroFactor;
  if (s > 0 && G.pd > 0) {
    // 目标姿态：轴心类型决定的“自然倾角”，倾斜方向以进动角速度绕竖直轴旋转。
    const lean = h.spec.bit.drift * Math.min(1, mag / (h.launchSpin * 0.5));
    // 自然进动角速度（只由转速决定）
    let rate = h.spinSign * -(T.precessBase + T.precessSpin / Math.max(20, mag));
    // 战术意图：牵引方向（= 倾斜方向 + 90°·旋向）接近期望方向时进动放慢、背离时加快。
    if (steering > 0) {
      const psi = h.precession + (h.spinSign * Math.PI) / 2;
      const d = Math.atan2(Math.sin(h.intent.heading - psi), Math.cos(h.intent.heading - psi));
      rate *= 1 - steering * Math.cos(d);
    }
    if (h.intent.state === 'launch' && T.launchHold > 0) {
      // 发射过渡：倾斜方向由发射决定，只在发射方向 ±launchBias 内以有限速率偏向拦截方向（不自由进动）
      const off = Math.atan2(Math.sin(h.intent.heading - h.launchHeading), Math.cos(h.intent.heading - h.launchHeading));
      const want = h.launchHeading + Math.max(-T.launchBias, Math.min(T.launchBias, off)) - (h.spinSign * Math.PI) / 2;
      const e = Math.atan2(Math.sin(want - h.precession), Math.cos(want - h.precession));
      h.precession += Math.max(-T.launchSlew * dt, Math.min(T.launchSlew * dt, e));
    } else h.precession += dt * rate;
    // 碰撞把轴撞歪：实际倾斜明显大于目标倾角时，进动相位跟随实际倾斜方向（牵引方向随之改变）
    const excess = h.tilt - lean - T.knockResync;
    if (excess > 0) {
      const az = Math.atan2(up.z, up.x);
      const k = Math.min(1, excess / 0.15) * (1 - Math.exp(-dt * T.knockRate));
      h.precession += Math.atan2(Math.sin(az - h.precession), Math.cos(az - h.precession)) * k;
      if (!h.knocked) h.knockResyncs++;
      h.knocked = true;
    } else h.knocked = false;
    const tx = Math.sin(lean) * Math.cos(h.precession);
    const tz = Math.sin(lean) * Math.sin(h.precession);
    const ty = Math.cos(lean);
    // 回正轴 = up × target
    const ax = up.y * tz - up.z * ty;
    const az = up.x * ty - up.y * tx;
    f.px += (T.uprightStiffness * s * ax - T.uprightDamping * s * f.px) * dt;
    f.pz += (T.uprightStiffness * s * az - T.uprightDamping * s * f.pz) * dt;
    f.py -= T.uprightDamping * s * f.py * dt;
  }
}

/** 各阶段读取的 BEY_TUNING 字段（类型上只声明用到的部分，取值仍是同一个 BEY_TUNING 对象） */
export interface RailTuning {
  railGearOnly: number;
  minStableSpin: number;
  railInward: number;
  railMaxSpeed: number;
  railDash: number;
  railSpinCost: number;
}
export interface TractionTuning {
  breakoutGrip: number;
  edgeGrip: number;
  driveMinGrip: number;
  minStableSpin: number;
  runupAngle: number;
  backoffEdge: number;
  driveSpeed: number;
  breakoutRatio: number;
  driveAccel: number;
  driveSpinCost: number;
  steerSpinCost: number;
}
export interface RollingTuning {
  rollBase: number;
  rollFriction: number;
}
export interface PostureTuning {
  minStableSpin: number;
  precessBase: number;
  precessSpin: number;
  launchHold: number;
  launchBias: number;
  launchSlew: number;
  knockResync: number;
  knockRate: number;
  uprightStiffness: number;
  uprightDamping: number;
}
