import type RAPIER from '@dimforge/rapier3d-compat';
import { ARENA, floorHeight } from '../arena/arenaSpec';
import { GRAVITY, type PhysicsWorld } from '../physics/PhysicsWorld';
import type { AssembledBey } from './parts/assemble';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface LaunchParams {
  position: Vec3;
  /** 水平速度 */
  velocity: Vec3;
  /** 转速（rad/s，正数），方向由 Blade 的旋转方向决定 */
  spin: number;
  /** 发射倾角（弧度），绕 tiltAxis 倾斜 */
  tilt?: number;
  tiltAxis?: Vec3;
}

/** 陀螺物理调参（集中在这里，方便后续平衡性调整） */
export const BEY_TUNING = {
  /** 低于这个转速时陀螺失去自稳 */
  minStableSpin: 7,
  /** 自稳回正刚度（rad/s² 每弧度） */
  uprightStiffness: 320,
  /** 自稳阻尼 */
  uprightDamping: 32,
  /** 空气阻力（与转速成正比的衰减） */
  airDrag: 0.004,
  /** 倾倒后边缘刮地的额外衰减 */
  scrapeDecay: 28,
  /** 极限轨道冲刺加速度 */
  railDash: 16,
  /** 极限轨道冲刺的转速消耗 */
  railSpinCost: 1.2,
  /** 冲刺最高水平速度 */
  railMaxSpeed: 9.5,
  /**
   * 进动基础角速度（rad/s）。牵引方向随进动旋转，攻击型的绕圈半径 ≈ 速度 / 进动角速度：
   * P2.2 诊断发现 1.0 rad/s 时半径约 3 米，正好是外圈轨道，攻击型绕 12 秒都碰不到中央的防御型；
   * 提高到 3.0 后每圈半径约 1.5–2 米、圈心随碗面漂移，轨迹像花瓣一样反复穿过中央。
   */
  precessBase: 3.0,
  /** 进动随转速降低而加快：+precessSpin / ω */
  precessSpin: 80,
  /** 冲刺方向向场地中心偏转的比例 */
  railInward: 0.8,
  /**
   * 轴心牵引（花瓣轨迹）：平底 / 橡胶轴心倾斜着咬地，接触面偏离转轴，
   * 转动的接触面与地面的摩擦把陀螺推向“垂直于倾斜方向”，倾斜方向随进动旋转 → 花瓣形轨迹。
   * 目标速度与加速度都按齿轮咬合度和剩余转速缩放。
   */
  driveSpeed: 8.5,
  driveAccel: 24,
  driveSpinCost: 0.35,
  /**
   * 轴心滚动 / 滑动阻力：水平减速度 = (rollBase + rollFriction × 轴心摩擦) × g。
   * 没有这一项时，陀螺在碗边的离心轨道几乎不损失能量，会长时间绕外圈（P2.1 诊断：最长 24 秒没有交锋）。
   */
  rollBase: 0.012,
  rollFriction: 0.06,
};

/**
 * 陀螺的刚体与碰撞体（与视觉模型分离）。
 * 本地原点在轴心最底部，Y 轴为旋转轴。
 *
 * 真实参与碰撞的部分：
 *  - Tip 球形接触点与场地之间的摩擦，会把转动转化成在碗面上的移动；
 *  - Blade / Disc 圆柱与对手、墙壁之间的碰撞与摩擦（转速差会产生切向冲量）。
 * 额外施加的力只有两类，用于模拟刚体引擎没有直接表达的现象：
 *  - 陀螺仪自稳：转速越高越不容易倾倒，转速低时自然倒下；
 *  - 齿轮咬合轨道的冲刺。
 */
export class BeyPhysics {
  readonly body: RAPIER.RigidBody;
  readonly colliders: RAPIER.Collider[] = [];
  readonly bladeCollider: RAPIER.Collider;
  readonly spec: AssembledBey;
  /** 当前转速大小（rad/s） */
  spin = 0;
  /** 发射时的转速，用于计算比例 */
  launchSpin = 1;
  /** 倾斜角（弧度） */
  tilt = 0;
  /** 是否在极限轨道上冲刺 */
  dashing = false;
  /** 是否接触地面 */
  grounded = false;
  private readonly pw: PhysicsWorld;
  private readonly spinSign: number;
  /** 进动相位（倾斜方向） */
  private precession = Math.random() * Math.PI * 2;

  constructor(pw: PhysicsWorld, spec: AssembledBey, launch: LaunchParams) {
    this.pw = pw;
    this.spec = spec;
    const { R, world } = pw;
    this.spinSign = spec.blade.spin === 'right' ? -1 : 1; // 右旋 = 俯视顺时针 = 绕 +Y 负方向

    const tilt = launch.tilt ?? 0;
    const axis = launch.tiltAxis ?? { x: 1, y: 0, z: 0 };
    const s = Math.sin(tilt / 2);
    const rotation = { x: axis.x * s, y: axis.y * s, z: axis.z * s, w: Math.cos(tilt / 2) };

    this.body = world.createRigidBody(
      R.RigidBodyDesc.dynamic()
        .setTranslation(launch.position.x, launch.position.y, launch.position.z)
        .setRotation(rotation)
        // P2.2 性能：Rapier 的完整 CCD（形状扫掠 + 子步）对着 6900 个三角形的碗面，
        // 每个物理步要 2.0ms（120Hz 下每帧 4ms，是主循环最大的 CPU 开销），关掉后每步 0.06ms。
        // 平时最快 11 m/s，每步移动 9cm，小于刀刃半径，不会穿透；
        // 只有高速下落（发射落地、被撞飞后落回）时临时打开 CCD，防止细针尖穿过碗面。见 preStep。
        .setCcdEnabled(false)
        .setCanSleep(false)
        .setLinearDamping(0.15)
        .setAngularDamping(0),
    );

    const { tip, disc, blade, layers } = spec;
    const events = R.ActiveEvents.COLLISION_EVENTS;

    // Tip：接地球 + 轴杆
    const ball = R.ColliderDesc.ball(tip.contactRadius)
      .setTranslation(0, tip.contactRadius, 0)
      .setMass(tip.mass * 0.6)
      .setFriction(tip.friction)
      // 摩擦相乘：低摩擦轴心在斜面上打滑、被重力拉回中心；高摩擦轴心抓地、绕场移动
      .setFrictionCombineRule(R.CoefficientCombineRule.Multiply)
      .setRestitution(0.1);
    const shaftH = Math.max(0.02, layers.tip.top - tip.contactRadius);
    const shaft = R.ColliderDesc.cylinder(shaftH / 2, 0.11)
      .setTranslation(0, tip.contactRadius + shaftH / 2, 0)
      .setMass(tip.mass * 0.4)
      .setFriction(0.2);
    // Disc
    const discDesc = R.ColliderDesc.cylinder(disc.height / 2, disc.radius)
      .setTranslation(0, layers.disc.center, 0)
      .setMass(disc.mass)
      .setFriction(0.3)
      // 金属对撞几乎不反弹：恢复系数低，弹开主要来自刀刃咬合冲量
      .setRestitution(0.1)
      .setActiveEvents(events);
    // Blade
    const bladeDesc = R.ColliderDesc.cylinder(blade.height / 2, blade.radius)
      .setTranslation(0, layers.blade.center, 0)
      .setMass(blade.mass)
      .setFriction(blade.friction)
      .setRestitution(blade.restitution * 0.4)
      .setActiveEvents(events);

    for (const d of [ball, shaft, discDesc]) this.colliders.push(world.createCollider(d, this.body));
    this.bladeCollider = world.createCollider(bladeDesc, this.body);
    this.colliders.push(this.bladeCollider);

    this.spin = launch.spin;
    this.launchSpin = Math.max(1, launch.spin);
    this.body.setLinvel(launch.velocity, true);
    const up = this.up();
    this.body.setAngvel(
      { x: up.x * launch.spin * this.spinSign, y: up.y * launch.spin * this.spinSign, z: up.z * launch.spin * this.spinSign },
      true,
    );
  }

  /** 陀螺当前的旋转轴（世界坐标） */
  up(): Vec3 {
    const q = this.body.rotation();
    // 把 (0,1,0) 用四元数旋转
    return {
      x: 2 * (q.x * q.y - q.w * q.z),
      y: 1 - 2 * (q.x * q.x + q.z * q.z),
      z: 2 * (q.y * q.z + q.w * q.x),
    };
  }

  /** 渲染用的插值位置与转轴（写入 out，避免每帧分配） */
  renderState(alpha: number, pos: Vec3, upOut: Vec3): void {
    const p = this.body.translation();
    const u = this.up();
    const a = this.hasPrev ? alpha : 1;
    const b = 1 - a;
    pos.x = this.prevPos.x * b + p.x * a;
    pos.y = this.prevPos.y * b + p.y * a;
    pos.z = this.prevPos.z * b + p.z * a;
    upOut.x = this.prevUp.x * b + u.x * a;
    upOut.y = this.prevUp.y * b + u.y * a;
    upOut.z = this.prevUp.z * b + u.z * a;
    const l = Math.hypot(upOut.x, upOut.y, upOut.z) || 1;
    upOut.x /= l;
    upOut.y /= l;
    upOut.z /= l;
  }

  /** 转速比例 0..1 */
  get spinRatio(): number {
    return Math.min(1, this.spin / this.launchSpin);
  }

  get spinDirection(): number {
    return this.spinSign;
  }

  ownsCollider(handle: number): boolean {
    return this.colliders.some((c) => c.handle === handle);
  }

  /** 上一个物理步结束时的位置与转轴（渲染插值用） */
  readonly prevPos: Vec3 = { x: 0, y: 0, z: 0 };
  readonly prevUp: Vec3 = { x: 0, y: 1, z: 0 };
  private hasPrev = false;
  private ccdOn = false;

  /** 每个物理步之前调用 */
  preStep(dt: number): void {
    const T = BEY_TUNING;
    const body = this.body;
    const up = this.up();
    const p0 = body.translation();
    this.prevPos.x = p0.x;
    this.prevPos.y = p0.y;
    this.prevPos.z = p0.z;
    this.prevUp.x = up.x;
    this.prevUp.y = up.y;
    this.prevUp.z = up.z;
    this.hasPrev = true;
    const lv = body.linvel();
    const needCcd = lv.y < -3.5 || lv.x * lv.x + lv.z * lv.z > 100;
    if (needCcd !== this.ccdOn) {
      this.ccdOn = needCcd;
      body.enableCcd(needCcd);
    }
    const w = body.angvel();
    const spinSigned = w.x * up.x + w.y * up.y + w.z * up.z;
    let px = w.x - up.x * spinSigned;
    let py = w.y - up.y * spinSigned;
    let pz = w.z - up.z * spinSigned;

    this.tilt = Math.acos(Math.max(-1, Math.min(1, up.y)));
    const pos = body.translation();
    const r = Math.hypot(pos.x, pos.z);
    const floorY = r <= ARENA.radius ? floorHeight(r) : -Infinity;
    this.grounded = pos.y - floorY < 0.12;

    // 1) 转速衰减：轴心恒定摩擦 + 空气阻力 + 倾倒刮地
    let mag = Math.abs(spinSigned);
    let decay = this.spec.tip.spinDecay + T.airDrag * mag;
    if (this.tilt > 0.5) decay += T.scrapeDecay * Math.min(1, (this.tilt - 0.5) * 2);

    // 2) 极限轨道：齿轮轴心咬合轨道冲刺
    this.dashing = false;
    const grip = this.spec.tip.gearGrip;
    if (grip > 0 && this.grounded && r > ARENA.railInner && r < ARENA.railOuter + 0.05 && mag > T.minStableSpin) {
      const ex = pos.x / r;
      const ez = pos.z / r;
      // ω × e_r 的水平分量（ω 竖直），冲刺方向为其反方向（齿轮在外圈齿条上滚动）
      const wy = this.spinSign * mag;
      // 轨道末端带一点向内的分量，让冲刺把陀螺“甩”回场地中央（Xtreme 冲刺的观感）
      let dx = -(wy * ez) / Math.max(1e-6, Math.abs(wy)) - ex * T.railInward;
      let dz = (wy * ex) / Math.max(1e-6, Math.abs(wy)) - ez * T.railInward;
      const len = Math.hypot(dx, dz) || 1;
      dx /= len;
      dz /= len;
      const v = body.linvel();
      const along = v.x * dx + v.z * dz;
      if (along < T.railMaxSpeed) {
        const accel = T.railDash * grip * Math.min(1, mag / (this.launchSpin * 0.4));
        const m = body.mass();
        body.applyImpulse({ x: dx * accel * m * dt, y: 0, z: dz * accel * m * dt }, true);
        decay += T.railSpinCost * grip;
        this.dashing = true;
      }
    }
    // 轴心牵引（花瓣轨迹）：方向垂直于当前倾斜方向，随进动旋转
    if (grip >= 0.5 && this.grounded && !this.dashing && mag > T.minStableSpin * 2) {
      const ratio = Math.min(1, mag / this.launchSpin);
      const v = body.linvel();
      const dx = -Math.sin(this.precession) * this.spinSign;
      const dz = Math.cos(this.precession) * this.spinSign;
      const along = v.x * dx + v.z * dz;
      if (along < T.driveSpeed * grip * (0.35 + 0.65 * ratio)) {
        const a = T.driveAccel * grip * ratio * body.mass() * dt;
        body.applyImpulse({ x: dx * a, y: 0, z: dz * a }, true);
        decay += T.driveSpinCost * grip;
      }
    }

    // 轴心滚动 / 滑动阻力：在碗面上持续损失水平速度，绕圈的陀螺会慢慢滑回中央与对手相遇
    if (this.grounded) {
      const v = body.linvel();
      const sp = Math.hypot(v.x, v.z);
      if (sp > 1e-3) {
        const dv = Math.min(sp, (T.rollBase + T.rollFriction * this.spec.tip.friction) * -GRAVITY * dt);
        const m = body.mass();
        body.applyImpulse({ x: (-v.x / sp) * dv * m, y: 0, z: (-v.z / sp) * dv * m }, true);
      }
    }

    mag = Math.max(0, mag - decay * dt);

    // 3) 陀螺仪自稳：转得越快越能保持直立
    const s = Math.max(0, Math.min(1, (mag - T.minStableSpin) / (this.launchSpin * 0.3)));
    if (s > 0) {
      // 目标姿态：轴心类型决定的“自然倾角”，倾斜方向以进动角速度绕竖直轴旋转。
      // 倾斜的轴心与地面的接触点偏离转轴，摩擦力方向随进动旋转，
      // 由 Rapier 的摩擦自然产生花瓣形移动轨迹（攻击型轴心倾角大、移动激烈）。
      this.precession += dt * this.spinSign * -(T.precessBase + T.precessSpin / Math.max(20, mag));
      const lean = this.spec.tip.drift * Math.min(1, mag / (this.launchSpin * 0.5));
      const tx = Math.sin(lean) * Math.cos(this.precession);
      const tz = Math.sin(lean) * Math.sin(this.precession);
      const ty = Math.cos(lean);
      // 回正轴 = up × target
      const ax = up.y * tz - up.z * ty;
      const az = up.x * ty - up.y * tx;
      px += (T.uprightStiffness * s * ax - T.uprightDamping * s * px) * dt;
      pz += (T.uprightStiffness * s * az - T.uprightDamping * s * pz) * dt;
      py -= T.uprightDamping * s * py * dt;
    }

    const sign = spinSigned === 0 ? this.spinSign : Math.sign(spinSigned);
    body.setAngvel(
      { x: px + up.x * mag * sign, y: py + up.y * mag * sign, z: pz + up.z * mag * sign },
      true,
    );
    this.spin = mag;
  }

  /** 施加水平撞击冲量 */
  applyImpulse(x: number, y: number, z: number): void {
    this.body.applyImpulse({ x, y, z }, true);
  }

  /** 撞击后的晃动：给一个绕水平轴的角速度 */
  wobble(wx: number, wz: number): void {
    const w = this.body.angvel();
    const max = 6;
    this.body.setAngvel(
      { x: w.x + Math.max(-max, Math.min(max, wx)), y: w.y, z: w.z + Math.max(-max, Math.min(max, wz)) },
      true,
    );
  }

  /** 撞击造成的转速损失 */
  loseSpin(amount: number): void {
    const up = this.up();
    const w = this.body.angvel();
    const spinSigned = w.x * up.x + w.y * up.y + w.z * up.z;
    const sign = Math.sign(spinSigned) || this.spinSign;
    const delta = Math.min(Math.abs(spinSigned), amount) * sign;
    this.body.setAngvel({ x: w.x - up.x * delta, y: w.y - up.y * delta, z: w.z - up.z * delta }, true);
  }

  dispose(): void {
    this.pw.world.removeRigidBody(this.body);
  }
}
