import type RAPIER from '@dimforge/rapier3d-compat';
import { ARENA, floorHeight } from '../arena/arenaSpec';
import { GRAVITY, type PhysicsWorld } from '../physics/PhysicsWorld';
import { REF_INERTIA, type AssembledBey } from './parts/assemble';

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
  /** 陀尖接地宽度对抗倾倒能力的影响（0 = 不影响，1 = 完全按宽度）。宽轴心（球头/平底）更难被撞倒 */
  tipStability: 0.5,
  /**
   * 轴心牵引（花瓣轨迹）：平底 / 橡胶轴心倾斜着咬地，接触面偏离转轴，
   * 转动的接触面与地面的摩擦把陀螺推向“垂直于倾斜方向”，倾斜方向随进动旋转 → 花瓣形轨迹。
   * 目标速度与加速度都按齿轮咬合度和剩余转速缩放。
   */
  // P2.3.1：8.5 / 24 → 10 / 30，真机反馈移动迟缓（基线平均水平速度 1.7 m/s）
  driveSpeed: 10,
  driveAccel: 30,
  driveSpinCost: 0.35,
  /**
   * P2.3.1 追击：轴心牵引方向向对手偏转的比例（再乘 0.4 + 0.6 × 刀刃攻击值）。
   * 只改变牵引力的方向，大小仍受轴心咬合度和剩余转速限制，没有额外推力。
   */
  pursuit: 0.8,
  /** 离中心超过这个半径时，拉开方向不再朝外（避免退到墙边） */
  backoffEdge: 2.0,
  /** 拉开阶段最长持续时间（秒），超时就直接冲 */
  backoffMax: 0.8,
  /** 撞击后拉开到两台外缘相距这么远再冲（助跑距离，米） */
  runup: 0.3,
  /** 拉开方向相对“背向对手”的偏转角（弧度），走弧线而不是直线后退 */
  runupAngle: 0.9,
  /** 僵持（两台都几乎不动、贴在一起）多久后触发脱困（秒） */
  stallTime: 0.6,
  /** 脱困持续时间（秒） */
  breakoutTime: 0.7,
  /** 脱困时牵引按不低于这个转速比例计算 */
  breakoutRatio: 0.8,
  /** 脱困时轴心咬合度至少按这个值（针尖平时 0.1，没有牵引） */
  breakoutGrip: 0.35,
  /** 撞击后先拉开、不再冲向对手的时间（秒） */
  recoilTime: 0.45,
  /** 低于这个咬合度的轴心（针尖）没有牵引。P2.2.1 为 0.5，球头（0.35）完全没有牵引，会停在碗底 */
  driveMinGrip: 0.2,
  /**
   * 轴心滚动 / 滑动阻力：水平减速度 = (rollBase + rollFriction × 轴心摩擦) × g。
   * 没有这一项时，陀螺在碗边的离心轨道几乎不损失能量，会长时间绕外圈（P2.1 诊断：最长 24 秒没有交锋）。
   */
  rollBase: 0.02,
  rollFriction: 0.02,
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
    this.inertiaRatio = REF_INERTIA / spec.spinInertia;
    // 抗倾倒 = 角动量（惯量）× 陀尖接地宽度：宽的平底 / 球头被撞歪时接触点外移、自己扶正；
    // 针尖几乎没有扶正力矩，被猛撞容易大幅倾斜、边缘刮地掉速
    const tipK = BEY_TUNING.tipStability;
    this.gyroFactor =
      Math.sqrt(spec.spinInertia / REF_INERTIA) * (1 - tipK + tipK * Math.min(1.3, spec.tip.contactRadius / 0.12));

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
  /** 参考惯量 / 实际惯量：摩擦力矩造成的掉速倍率 */
  private readonly inertiaRatio: number;
  /** 陀螺自稳强度倍率（√(I / 参考惯量)） */
  private readonly gyroFactor: number;
  private ccdOn = false;
  /** 对手位置（由对战系统每步写入），用于追击 */
  target: Vec3 | null = null;
  /** 撞击后的回弹计时（秒），大于 0 时先拉开距离 */
  recoil = 0;
  /** 脱困计时（秒） */
  breakout = 0;
  /** 追击状态：true = 冲向对手，false = 先拉开助跑距离 */
  private charging = true;
  private backoff = 0;

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
    if (this.recoil > 0) this.recoil -= dt;
    if (this.breakout > 0) this.breakout -= dt;
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
    // 轴心摩擦、牵引、刮地都是“力矩”，转速下降 = 力矩 / 转动惯量：
    // 同样的轴心，惯量大（重量集中在外缘）的陀螺掉速更慢 → 耐力型的优势来自零件本身
    let decay = this.spec.tip.spinDecay;
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
    // 脱困时针尖这类几乎没有牵引的轴心也按 breakoutGrip 计算（低转速晃动时轴心与碗面接触点外移，能“走”起来）
    const driveGrip = this.breakout > 0 ? Math.max(grip, T.breakoutGrip) : grip;
    if (driveGrip >= T.driveMinGrip && this.grounded && !this.dashing && mag > T.minStableSpin * 2) {
      const ratio = Math.min(1, mag / this.launchSpin);
      const v = body.linvel();
      let dx = -Math.sin(this.precession) * this.spinSign;
      let dz = Math.cos(this.precession) * this.spinSign;
      // 追击：牵引方向向对手偏转（攻击值越高偏得越多），只改方向不加力
      if (this.target) {
        const ox = this.target.x - pos.x;
        const oz = this.target.z - pos.z;
        const ol = Math.hypot(ox, oz);
        if (ol > 1e-3) {
          const k = this.breakout > 0 ? 1 : T.pursuit * (0.4 + 0.6 * this.spec.blade.attack);
          let gx = ox / ol;
          let gz = oz / ol;
          // 刚撞完先斜着拉开（留出助跑距离），再冲回来，不会一直压在对手身上变成持续摩擦。
          // 冲撞 / 拉开两种状态带滞回：拉开到助跑距离（或拉开超时）才转为冲撞，冲撞一直到撞上为止。
          // 只按距离切换会在临界距离上来回翻转，变成绕着对手打转（P2.3.1 调试中出现过 15 秒不碰的绕圈）。
          if (this.breakout > 0 || this.recoil > 0) {
            this.charging = false;
            this.backoff = 0;
          } else if (!this.charging) {
            this.backoff += dt;
            if (ol > this.spec.outerRadius * 2 + T.runup || this.backoff > T.backoffMax) this.charging = true;
          }
          if (!this.charging) {
            const c = Math.cos(T.runupAngle);
            const s = Math.sin(T.runupAngle) * this.spinSign;
            const ax = -gx;
            const az = -gz;
            gx = ax * c - az * s;
            gz = ax * s + az * c;
            // 靠外圈时不往墙的方向退：去掉朝外的分量（拉开只在场内绕一小段弧）
            if (r > T.backoffEdge) {
              const ex = pos.x / r;
              const ez = pos.z / r;
              const out = gx * ex + gz * ez;
              if (out > 0) {
                const w = Math.min(1, (r - T.backoffEdge) / 1.5);
                gx -= ex * out * w;
                gz -= ez * out * w;
                const gl = Math.hypot(gx, gz) || 1;
                gx /= gl;
                gz /= gl;
              }
            }
          }
          dx = dx * (1 - k) + gx * k;
          dz = dz * (1 - k) + gz * k;
          const dl = Math.hypot(dx, dz) || 1;
          dx /= dl;
          dz /= dl;
        }
      }
      const along = v.x * dx + v.z * dz;
      if (along < T.driveSpeed * driveGrip * (0.35 + 0.65 * (this.breakout > 0 ? Math.max(ratio, T.breakoutRatio) : ratio))) {
        // 脱困（辅助机制）：低转速的球头 / 针尖轴心牵引很弱，停在碗底会一直原地互转。
        // 僵持一段时间后，按“至少 breakoutRatio 的转速、breakoutGrip 的咬合度”给 0.7 秒牵引，方向背离对手；
        // 力的大小仍按轴心牵引公式与速度上限计算，拉开后由碗面重力拉回、真实碰撞
        const r2 = this.breakout > 0 ? Math.max(ratio, T.breakoutRatio) : ratio;
        const a = T.driveAccel * driveGrip * r2 * body.mass() * dt;
        body.applyImpulse({ x: dx * a, y: 0, z: dz * a }, true);
        decay += T.driveSpinCost * driveGrip;
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

    decay = decay * this.inertiaRatio + T.airDrag * mag;
    mag = Math.max(0, mag - decay * dt);

    // 3) 陀螺仪自稳：转得越快越能保持直立；角动量 L = Iω 越大越难被撞歪（防御 / 耐力型更稳）
    const s =
      Math.max(0, Math.min(1, (mag - T.minStableSpin) / (this.launchSpin * 0.3))) * this.gyroFactor;
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
