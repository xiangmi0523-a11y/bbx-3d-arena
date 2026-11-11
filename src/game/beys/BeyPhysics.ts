import type RAPIER from '@dimforge/rapier3d-compat';
import { ARENA, floorHeight, floorNormal } from '../arena/arenaSpec';
import { emptyGyroState, FLAT_TIP, GYRO_EXPERIMENT, gyroRecover, gyroStep, type GyroState } from '../physics/gyro';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import { MotionIntent, type AiLevel } from './motionIntent';
import { beyMassProps, type MassProps } from './massProps';
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
  /** 战术意图的随机种子（省略则取 Math.random） */
  seed?: number;
  /** AI 难度（只改决策参数，见 motionIntent.ts AI_LEVELS）；省略 = 'pro' 标准 */
  ai?: AiLevel;
}

/**
 * 自转账本（v2.0 S1 任务 1.3 / E7）：一台陀螺本回合按来源分解的转速变化（rad/s，累计量）。
 * 只做记账：与物理计算并行累加，不参与任何物理量的计算（golden 逐位不变）。
 *  - base / scrape / rail / drive / steer / burst / air：preStep 里游戏层衰减的各个分项（已按惯量比换算，按实际扣除量分摊）；
 *  - smash：刀刃咬合结算的掉速（BattleSystem.resolveSmash → loseSpin）；
 *  - claw：重击（D1 方案 A，clawStrike.ts）冲量造成的转速变化（施加前后角速度在转轴上的投影之差，正 = 掉速；只在实验开关打开时非零）；
 *  - contactLoss / contactGain：两次 preStep 之间 Rapier 积分对转速的改变（接触摩擦、陀螺耦合等），扣除 smash、claw 后按正负分开。
 */
export interface SpinLedger {
  base: number;
  scrape: number;
  rail: number;
  drive: number;
  steer: number;
  burst: number;
  air: number;
  smash: number;
  claw: number;
  contactLoss: number;
  contactGain: number;
}

export const emptyLedger = (): SpinLedger => ({ base: 0, scrape: 0, rail: 0, drive: 0, steer: 0, burst: 0, air: 0, smash: 0, claw: 0, contactLoss: 0, contactGain: 0 });

/** 爆裂后剩余部分的额外转速衰减（rad/s²，按参考惯量；只影响回合结束后的表现） */
const BURST_SPINDOWN = 60;

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
   * 自主运动重构：战术意图只调制进动相位的转速（见 motionIntent.ts），不再直接混合牵引方向。
   * 调制深度上限 < 1，相位永远沿自然方向转动；转向需要改变轴的倾斜方向，按调制深度额外消耗转速（rad/s²）。
   */
  steerSpinCost: 0.25,
  /**
   * 碰撞改变轴心倾斜：被撞歪后，实际倾斜超过目标倾角这么多（弧度）时，进动相位跟随实际倾斜方向，
   * 牵引方向因此改变（被撞后的轨迹由真实倾斜决定，而不是继续沿撞前的相位）。
   */
  knockResync: 0.12,
  /** 相位跟随实际倾斜的速率（1/s） */
  knockRate: 15,
  /**
   * 第二轮修正 2：发射过渡（由 INTENT_TUNING.launchAssist 开关，见 alignLaunch）。
   * 发射器把陀螺沿发射方向甩出，落地时的初始倾斜方向由发射决定（牵引沿发射方向），而不是随机相位；
   * 初始牵引方向可以向拦截方向偏，但偏角不超过发射方向 ±launchBias（弧度）。默认（launchHold 0）只设定这个初相，之后照常自由进动。
   * launchHold 1 是试过但没采用的方案：过渡期内把倾斜方向按至多 launchSlew（rad/s）保持在该方向，
   * 实测牵引持续顺着发射方向，错过对手时会一路加速冲出场外（96 场里 3–7 场出界）。
   * 牵引力大小、上限、转速消耗仍按轴心牵引公式计算，不改速度、不加额外冲量。
   */
  launchBias: 0.35,
  launchSlew: 3,
  /** 1 = 过渡期内倾斜方向保持在发射方向附近（不自由进动）；0 = 只决定初相，之后照常自由进动 */
  launchHold: 0,
  /** launchHold 0 时：初相往回退 自然进动角速度 × launchPre / 2，让前 launchPre 秒的牵引对称地扫过目标方向 */
  launchPre: 0.4,
  /** 进攻倾向（刀刃 attack − 0.5·defense）低于这个值的配置（防御 / 耐力刀刃）不设定发射初相，保持随机初相（与第一轮相同） */
  launchMinAggr: 0.2,
  /** 脱困方向：离中心超过这个半径时不再朝外（避免退到墙边） */
  backoffEdge: 2.0,
  /** 脱困方向相对“背向对手”的偏转角（弧度） */
  runupAngle: 0.9,
  /**
   * 第三轮实验：通用僵持脱困开关（BattleSystem.watchStall 第一分支）。1 = 开启（0c30c09 行为）；
   * 0 = 关闭：不再因“双方低速 + 中心距接近”而给双方脱困牵引，僵持计时 stallFor 保持 0。
   * 关闭只影响通用僵持；死亡摇摆脱离（wobbleBreak）不受影响。
   */
  stallBreak: 0,
  /** 僵持（两台都几乎不动、贴在一起）多久后触发脱困（秒） */
  stallTime: 0.6,
  /** 脱困持续时间（秒） */
  breakoutTime: 0.7,
  /**
   * 第二轮修正 4：死亡摇摆脱离（BattleSystem.watchStall）。同时满足才算：
   * 一台转速比例 < wobbleSpin 且实际倾斜比轴心自然倾角大 wobbleTilt（弧度）以上、两台刀刃持续接触 wobbleTime 秒、
   * 另一台转速比例比它高 wobbleMargin 以上且还有牵引能力。只让较健康的一台按原有脱困机制离开，摇摆的一台不受干预。
   * 高转速正常摩擦（转速高、轴基本竖直）不满足前两条。wobbleBreak 0 = 关闭。
   */
  wobbleBreak: 1,
  wobbleSpin: 0.25,
  wobbleTilt: 0.25,
  wobbleTime: 0.8,
  wobbleMargin: 0.04,
  /** 触发后至少隔这么久才会再次触发（秒） */
  wobbleCooldown: 1.5,
  /** 脱困时牵引按不低于这个转速比例计算 */
  breakoutRatio: 0.8,
  /** 脱困时轴心咬合度至少按这个值（针尖平时 0.1，没有牵引） */
  breakoutGrip: 0.35,
  /**
   * 第二轮修正 1：墙边保护对没有牵引的轴心（针尖）也要有作用。深入外圈时按至多 edgeGrip 的咬合度计算牵引
   * （与脱困 breakoutGrip 同一假设），方向仍由进动相位 + 墙边修正决定。0 = 关闭。
   */
  edgeGrip: 0.3,
  /**
   * 低于这个咬合度的轴心没有牵引。P2.2.1 为 0.5，球头（0.35）完全没有牵引，会停在碗底；
   * 0.2 时针尖（0.1）被二值门整个关掉，针尖对针尖可无接触僵持 35–87 s（v2.0 R3 的结构根因）。
   * v2.0 R3 实验值 0.1 未通过预注册规则（M2 实验 B：针尖对针尖 2 s 重接触 61% < 90%，无接触低速段最长 47 s > 5 s），
   * 按规则保持 0.2。根因：滚动阻力下限 (rollBase + rollFriction × 摩擦) × g ≈ 0.45 m/s² 与针尖经相位调制后的平均导向推力
   * （≈ 3 m/s² × 平均偏置 0.15）相当，碗面中心平台的回中梯度只有约 0.08 m/s²——三者合起来针尖几乎不动。留给 M4 处理。
   */
  driveMinGrip: 0.2,
  /**
   * v2.0 R8 轨道冲刺齿轮门控：1 = 只有带齿轮的 Bit（gear = true）能在轨道上冲刺，加速度与转速代价固定（不再乘 grip）；
   * 0 = 旧行为（任何 grip > 0 的轴心都冲刺，按 grip 缩放）。真实机制是齿轮与轨道齿条啮合，与抓地力无关。
   * M2 起采用（v2.0 D-A5 已确定）。实测轨道冲刺在签名矩阵里平均每回合只有约 0.01 s：陀螺很少走到轨道区，见 M4。
   */
  railGearOnly: 1,
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
 *  - Bit 球形接触点与场地之间的摩擦，会把转动转化成在碗面上的移动；
 *  - Blade / Ratchet 圆柱与对手、墙壁之间的碰撞与摩擦（转速差会产生切向冲量）。
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
  /** 发射方向（水平，弧度） */
  private readonly launchHeading: number;
  private launchAligned = false;
  /** 设定发射初相前的随机初相：第一步时若已经贴着对手（不在 launch 状态），恢复它 */
  private launchPhase0: number | null = null;
  /** 被撞歪后相位跟随实际倾斜的累计次数（诊断） */
  knockResyncs = 0;
  /** 本步进动相位是否在跟随被撞歪的实际倾斜 */
  knocked = false;
  /** 自转账本（只记账，见 SpinLedger） */
  readonly ledger: SpinLedger = emptyLedger();
  /** 上一次 preStep 写回的转速、之后 loseSpin 扣掉的量（账本用） */
  private ledgerWritten = -1;
  private ledgerSmash = 0;
  private ledgerClaw = 0;
  /**
   * 刚体质量属性（解析，与下方创建的碰撞体逐一对应，见 massProps.ts；CI 用 Rapier 的冲量响应核对）。
   * 只供重击模型的有效质量与能量审计读取，不参与其他物理计算。
   */
  readonly massProps: MassProps;
  /** 爆裂后（刀刃脱离）的质量属性：陀螺项实验（GYRO_EXPERIMENT）用 */
  private readonly massPropsNoBlade: MassProps;
  /** 陀螺项实验的逐步状态（只在 GYRO_EXPERIMENT.enabled 时使用） */
  private readonly gyroState: GyroState = emptyGyroState();

  constructor(pw: PhysicsWorld, spec: AssembledBey, launch: LaunchParams) {
    // B2 实验：平底类轴心用圆角圆柱接地（只在构造时读取开关）
    const flatTip = GYRO_EXPERIMENT.flatTip > 0 && (spec.bit.visual.shape === 'gear-flat' || spec.bit.visual.shape === 'rubber') ? FLAT_TIP : null;
    this.massProps = beyMassProps(spec, { flatTip });
    this.massPropsNoBlade = beyMassProps(spec, { withBlade: false, flatTip });
    this.pw = pw;
    this.spec = spec;
    // 战术意图的随机种子：游戏里来自 Math.random（每局不同），测试里由固定种子决定
    this.intent = new MotionIntent(spec, launch.seed ?? Math.floor(Math.random() * 2 ** 32), launch.ai);
    const { R, world } = pw;
    this.spinSign = spec.blade.spin === 'right' ? -1 : 1; // 右旋 = 俯视顺时针 = 绕 +Y 负方向
    this.inertiaRatio = REF_INERTIA / spec.spinInertia;
    // 抗倾倒 = 角动量（惯量）× 陀尖接地宽度：宽的平底 / 球头被撞歪时接触点外移、自己扶正；
    // 针尖几乎没有扶正力矩，被猛撞容易大幅倾斜、边缘刮地掉速
    const tipK = BEY_TUNING.tipStability;
    this.gyroFactor =
      Math.sqrt(spec.spinInertia / REF_INERTIA) * (1 - tipK + tipK * Math.min(1.3, spec.bit.contactRadius / 0.12));

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

    const { bit, ratchet, blade, layers } = spec;
    const events = R.ActiveEvents.COLLISION_EVENTS;

    // Bit：接地球 + 轴杆（碰撞体的形状、质量、位置改动时同步修改 massProps.ts；tests/clawPhysics.test.ts 会核对）
    const tipDesc = flatTip
      ? R.ColliderDesc.roundCylinder(flatTip.halfHeight, bit.contactRadius - flatTip.border, flatTip.border).setTranslation(0, flatTip.halfHeight + flatTip.border, 0)
      : R.ColliderDesc.ball(bit.contactRadius).setTranslation(0, bit.contactRadius, 0);
    const ball = tipDesc
      .setMass(bit.mass * 0.6)
      .setFriction(bit.friction)
      // 摩擦相乘：低摩擦轴心在斜面上打滑、被重力拉回中心；高摩擦轴心抓地、绕场移动
      .setFrictionCombineRule(R.CoefficientCombineRule.Multiply)
      .setRestitution(0.1);
    const shaftH = Math.max(0.02, layers.bit.top - bit.contactRadius);
    const shaft = R.ColliderDesc.cylinder(shaftH / 2, 0.11)
      .setTranslation(0, bit.contactRadius + shaftH / 2, 0)
      .setMass(bit.mass * 0.4)
      .setFriction(0.2);
    // Ratchet
    const ratchetDesc = R.ColliderDesc.cylinder(ratchet.height / 2, ratchet.radius)
      .setTranslation(0, layers.ratchet.center, 0)
      .setMass(ratchet.mass)
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

    for (const d of [ball, shaft, ratchetDesc]) this.colliders.push(world.createCollider(d, this.body));
    this.bladeCollider = world.createCollider(bladeDesc, this.body);
    this.colliders.push(this.bladeCollider);

    this.launchHeading = Math.atan2(launch.velocity.z, launch.velocity.x);
    this.spin = launch.spin;
    this.ledgerWritten = launch.spin;
    this.launchSpin = Math.max(1, launch.spin);
    this.body.setLinvel(launch.velocity, true);
    const up = this.up();
    this.body.setAngvel(
      { x: up.x * launch.spin * this.spinSign, y: up.y * launch.spin * this.spinSign, z: up.z * launch.spin * this.spinSign },
      true,
    );
  }

  /** 陀螺当前的旋转轴（世界坐标） */
  /** 世界坐标质心：刚体原点 + 转轴 × 质心高度（全部碰撞体同轴叠放，质心在本地 y 轴上） */
  comWorld(): Vec3 {
    const p = this.body.translation();
    const u = this.up();
    const h = this.massProps.comY;
    return { x: p.x + u.x * h, y: p.y + u.y * h, z: p.z + u.z * h };
  }

  /**
   * 账本：记录一次重击冲量造成的转速变化（loss > 0 = 掉速），并从下一次 preStep 测到的 Rapier 积分变化里扣除（只记账，不改物理）。
   */
  recordClaw(loss: number): void {
    this.ledger.claw += loss;
    this.ledgerClaw += loss;
  }

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
  /** 对手（由对战系统写入），战术意图读取它的位置、速度和转速 */
  opponent: BeyPhysics | null = null;
  /** 脱困计时（秒） */
  breakout = 0;
  /** 战术意图（有状态、确定性随机）。只调制进动相位转速，不施加力 */
  readonly intent: MotionIntent;
  /** 当前战术状态名（诊断 / 测试读取） */
  get intentState(): string {
    return this.intent.state;
  }

  /** 每个物理步之前调用 */
  /**
   * 发射过渡（第二轮修正 2）：两台都发射后由 BattleSystem 调用一次，在第一步之前设定落地时的初始倾斜方向（进动初相）。
   * 发射器沿发射方向甩出陀螺，倾斜方向由发射决定：牵引方向 = 发射方向向对手拦截方向偏，但不超过 ±launchBias。
   * launchHold 0（默认）时初相再往回退 自然进动 × launchPre / 2，之后照常自由进动，前 launchPre 秒的牵引对称扫过该方向。
   * 只改初相（一个本来就是随机数的初始条件），不改速度、不加冲量；牵引力大小与上限仍按轴心公式。
   */
  alignLaunch(opp: BeyPhysics): void {
    if (this.launchAligned) return;
    this.launchAligned = true;
    if (this.intent.state !== 'launch' || this.intent.profile.aggression < BEY_TUNING.launchMinAggr) return;
    this.launchPhase0 = this.precession;
    const p = this.body.translation();
    const v = this.body.linvel();
    const op = opp.body.translation();
    const ov = opp.body.linvel();
    const d = Math.hypot(op.x - p.x, op.z - p.z);
    const lead = Math.min(0.6, d / Math.max(2, Math.hypot(v.x, v.z)));
    const ih = Math.atan2(op.z + ov.z * lead - p.z, op.x + ov.x * lead - p.x);
    const T = BEY_TUNING;
    const off = Math.atan2(Math.sin(ih - this.launchHeading), Math.cos(ih - this.launchHeading));
    this.precession = this.launchHeading + Math.max(-T.launchBias, Math.min(T.launchBias, off)) - (this.spinSign * Math.PI) / 2;
    if (T.launchHold <= 0) {
      const rate0 = this.spinSign * -(T.precessBase + T.precessSpin / Math.max(20, Math.abs(this.spin)));
      this.precession -= (rate0 * T.launchPre) / 2;
    }
  }

  preStep(dt: number): void {
    const T = BEY_TUNING;
    // 已经开始运动后不再设定初相
    this.launchAligned = true;
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
    if (this.breakout > 0) this.breakout -= dt;
    const lv = body.linvel();
    const needCcd = lv.y < -3.5 || lv.x * lv.x + lv.z * lv.z > 100;
    if (needCcd !== this.ccdOn) {
      this.ccdOn = needCcd;
      body.enableCcd(needCcd);
    }
    const G = GYRO_EXPERIMENT;
    // 陀螺项实验：上一步交给 Rapier 的是等效角速度，这里恢复真实角速度（见 physics/gyro.ts）
    const w = G.enabled > 0 ? gyroRecover(body.angvel(), up, this.gyroState) : body.angvel();
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
    // 账本：上一步写回之后的变化 = Rapier 积分 + 咬合掉速（只记账）
    if (this.ledgerWritten >= 0) {
      const d = mag - this.ledgerWritten + this.ledgerSmash + this.ledgerClaw;
      if (d < 0) this.ledger.contactLoss -= d;
      else this.ledger.contactGain += d;
    }
    this.ledgerSmash = 0;
    this.ledgerClaw = 0;
    let lScrape = 0;
    let lRail = 0;
    let lDrive = 0;
    let lSteer = 0;
    // 轴心摩擦、牵引、刮地都是“力矩”，转速下降 = 力矩 / 转动惯量：
    // 同样的轴心，惯量大（重量集中在外缘）的陀螺掉速更慢 → 耐力型的优势来自零件本身
    let decay = this.spec.bit.spinDecay;
    if (this.tilt > 0.5 && GYRO_EXPERIMENT.scrape > 0) {
      lScrape = T.scrapeDecay * Math.min(1, (this.tilt - 0.5) * 2);
      decay += T.scrapeDecay * Math.min(1, (this.tilt - 0.5) * 2);
    }
    // 爆裂后只剩 Ratchet + Bit：失去刀刃的惯量与驱动，很快停转倾倒（回合已由规则结束，只是表现）
    if (this.bursted) decay += BURST_SPINDOWN;

    // 2) 极限轨道：齿轮轴心咬合轨道冲刺
    this.dashing = false;
    const grip = this.spec.bit.gearGrip;
    // 齿轮门控（R8）：冲刺资格来自齿轮，强度不随抓地力缩放
    const gearOnly = T.railGearOnly > 0;
    const canDash = gearOnly ? this.spec.bit.gear : grip > 0;
    const dashK = gearOnly ? 1 : grip;
    if (!this.bursted && canDash && this.grounded && r > ARENA.railInner && r < ARENA.railOuter + 0.05 && mag > T.minStableSpin) {
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
        const accel = T.railDash * dashK * Math.min(1, mag / (this.launchSpin * 0.4));
        const m = body.mass();
        body.applyImpulse({ x: dx * accel * m * dt, y: 0, z: dz * accel * m * dt }, true);
        decay += T.railSpinCost * dashK;
        lRail = T.railSpinCost * dashK;
        this.dashing = true;
      }
    }
    // 战术意图：决定“希望牵引指向哪里”和调制深度（不施力）
    const opp = this.opponent;
    if (opp) {
      const op = opp.body.translation();
      const ov = opp.body.linvel();
      const v0 = body.linvel();
      this.intent.update({
        dt,
        px: pos.x,
        pz: pos.z,
        vx: v0.x,
        vz: v0.z,
        ox: op.x,
        oz: op.z,
        ovx: ov.x,
        ovz: ov.z,
        bladeSum: this.spec.blade.radius + opp.spec.blade.radius,
        outerSum: this.spec.outerRadius + opp.spec.outerRadius,
        spinRatio: this.spinRatio,
        oppSpinRatio: opp.spinRatio,
        oppAggression: opp.intent.profile.aggression,
      });
    }
    // 第一步就已经贴着对手（意图直接进入 contact，例如测试里发射后摆放成接触），发射初相不适用，恢复原随机初相
    if (this.launchPhase0 !== null) {
      if (this.intent.state !== 'launch') this.precession = this.launchPhase0;
      this.launchPhase0 = null;
    }

    // 轴心牵引（花瓣轨迹）：方向垂直于当前倾斜方向，随进动旋转。
    // 方向只由进动相位决定；战术意图通过调节相位转速间接影响它（见下方自稳部分）。
    // 脱困时针尖这类几乎没有牵引的轴心也按 breakoutGrip 计算（低转速晃动时轴心与碗面接触点外移，能“走”起来）
    let driveGrip = this.breakout > 0 ? Math.max(grip, T.breakoutGrip) : grip;
    // 墙边：没有牵引的轴心（针尖）贴近外圈时，与脱困同理按 edgeGrip 计算牵引（倾斜着压在陡坡上，接触点外移）
    if (T.edgeGrip > 0 && this.intent.edgeW > 0) driveGrip = Math.max(driveGrip, T.edgeGrip * Math.min(1, this.intent.edgeW * 2));
    let steering = 0;
    if (!this.bursted && driveGrip >= T.driveMinGrip && this.grounded && !this.dashing && mag > T.minStableSpin * 2) {
      const ratio = Math.min(1, mag / this.launchSpin);
      const v = body.linvel();
      let dx = -Math.sin(this.precession) * this.spinSign;
      let dz = Math.cos(this.precession) * this.spinSign;
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
          dx = -Math.sin(phi) * this.spinSign;
          dz = Math.cos(phi) * this.spinSign;
        }
        driveScale = Math.min(1, sinRel / Math.max(1e-3, Math.sin(this.spec.bit.drift)));
      }
      // 脱困（P2.3.1 辅助机制，保持原样）：牵引方向背离对手并偏开 runupAngle，靠外圈时不朝墙
      if (this.breakout > 0 && opp) {
        const op = opp.body.translation();
        const ox = op.x - pos.x;
        const oz = op.z - pos.z;
        const ol = Math.hypot(ox, oz);
        if (ol > 1e-3) {
          const c = Math.cos(T.runupAngle);
          const sn = Math.sin(T.runupAngle) * this.spinSign;
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
      steering = this.breakout > 0 || G.tiltDrive > 0 ? 0 : this.intent.authority;
      const along = v.x * dx + v.z * dz;
      // 借来的墙边咬合（轴心本身没有牵引）只在牵引方向与墙边修正方向夹角 < 90° 时起作用：
      // 否则针尖会在外圈获得随相位乱转的推力，越转越快（实测耐力型游走从 1 m/s 加速到 6 m/s 沿墙绕）
      const edgeOnly = this.breakout <= 0 && grip < T.driveMinGrip;
      const edgeHelps = !edgeOnly || dx * Math.cos(this.intent.heading) + dz * Math.sin(this.intent.heading) > 0;
      if (G.explicitDrive > 0 && edgeHelps && along < T.driveSpeed * driveGrip * (0.35 + 0.65 * (this.breakout > 0 ? Math.max(ratio, T.breakoutRatio) : ratio))) {
        // 脱困（辅助机制）：低转速的球头 / 针尖轴心牵引很弱，停在碗底会一直原地互转。
        // 僵持一段时间后，按“至少 breakoutRatio 的转速、breakoutGrip 的咬合度”给 0.7 秒牵引，方向背离对手；
        // 力的大小仍按轴心牵引公式与速度上限计算，拉开后由碗面重力拉回、真实碰撞
        const r2 = this.breakout > 0 ? Math.max(ratio, T.breakoutRatio) : ratio;
        const a = T.driveAccel * driveGrip * r2 * body.mass() * dt * driveScale;
        body.applyImpulse({ x: dx * a, y: 0, z: dz * a }, true);
        decay += T.driveSpinCost * driveGrip;
        lDrive = T.driveSpinCost * driveGrip;
      }
      // 改变轴的倾斜方向需要力矩：按调制深度额外消耗转速
      decay += T.steerSpinCost * steering * driveGrip;
      lSteer = T.steerSpinCost * steering * driveGrip;
    }

    // 轴心滚动 / 滑动阻力：在碗面上持续损失水平速度，绕圈的陀螺会慢慢滑回中央与对手相遇
    if (this.grounded) {
      const v = body.linvel();
      const sp = Math.hypot(v.x, v.z);
      if (sp > 1e-3) {
        const dv = Math.min(sp, (T.rollBase + T.rollFriction * this.spec.bit.friction) * this.pw.g * dt);
        const m = body.mass();
        body.applyImpulse({ x: (-v.x / sp) * dv * m, y: 0, z: (-v.z / sp) * dv * m }, true);
      }
    }

    const mag0 = mag;
    decay = decay * this.inertiaRatio + T.airDrag * mag;
    mag = Math.max(0, mag - decay * dt);
    // 账本：本步实际扣除量按各分项比例分摊（转速见底时扣除量 < decay·dt）
    if (decay > 0) {
      const L = this.ledger;
      const f = ((mag0 - mag) / (decay * dt)) * dt;
      const k = this.inertiaRatio * f;
      L.base += this.spec.bit.spinDecay * k;
      L.scrape += lScrape * k;
      L.rail += lRail * k;
      L.drive += lDrive * k;
      L.steer += lSteer * k;
      if (this.bursted) L.burst += BURST_SPINDOWN * k;
      L.air += T.airDrag * mag0 * f;
    }

    // 3) 陀螺仪自稳：转得越快越能保持直立；角动量 L = Iω 越大越难被撞歪（防御 / 耐力型更稳）
    const s =
      Math.max(0, Math.min(1, (mag - T.minStableSpin) / (this.launchSpin * 0.3))) * this.gyroFactor;
    if (s > 0 && G.pd > 0) {
      // 目标姿态：轴心类型决定的“自然倾角”，倾斜方向以进动角速度绕竖直轴旋转。
      // 倾斜的轴心与地面的接触点偏离转轴，摩擦力方向随进动旋转，
      // 由 Rapier 的摩擦自然产生花瓣形移动轨迹（攻击型轴心倾角大、移动激烈）。
      const lean = this.spec.bit.drift * Math.min(1, mag / (this.launchSpin * 0.5));
      // 自然进动角速度（只由转速决定）
      let rate = this.spinSign * -(T.precessBase + T.precessSpin / Math.max(20, mag));
      // 战术意图：牵引方向（= 倾斜方向 + 90°·旋向）接近期望方向时进动放慢、背离时加快。
      // rate × (1 − a·cosΔ)，a < 1 → 相位永远沿自然方向转动，不会锁死；平均下来牵引偏向期望方向 (1−√(1−a²))/a
      if (steering > 0) {
        const psi = this.precession + (this.spinSign * Math.PI) / 2;
        const d = Math.atan2(Math.sin(this.intent.heading - psi), Math.cos(this.intent.heading - psi));
        rate *= 1 - steering * Math.cos(d);
      }
      if (this.intent.state === 'launch' && T.launchHold > 0) {
        // 发射过渡：倾斜方向由发射决定，只在发射方向 ±launchBias 内以有限速率偏向拦截方向（不自由进动）
        const off = Math.atan2(Math.sin(this.intent.heading - this.launchHeading), Math.cos(this.intent.heading - this.launchHeading));
        const want = this.launchHeading + Math.max(-T.launchBias, Math.min(T.launchBias, off)) - (this.spinSign * Math.PI) / 2;
        const e = Math.atan2(Math.sin(want - this.precession), Math.cos(want - this.precession));
        this.precession += Math.max(-T.launchSlew * dt, Math.min(T.launchSlew * dt, e));
      } else this.precession += dt * rate;
      // 碰撞把轴撞歪：实际倾斜明显大于目标倾角时，进动相位跟随实际倾斜方向（牵引方向随之改变）
      const excess = this.tilt - lean - T.knockResync;
      if (excess > 0) {
        const az = Math.atan2(up.z, up.x);
        const k = Math.min(1, excess / 0.15) * (1 - Math.exp(-dt * T.knockRate));
        this.precession += Math.atan2(Math.sin(az - this.precession), Math.cos(az - this.precession)) * k;
        if (!this.knocked) this.knockResyncs++;
        this.knocked = true;
      } else this.knocked = false;
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
    const wNew = { x: px + up.x * mag * sign, y: py + up.y * mag * sign, z: pz + up.z * mag * sign };
    if (G.enabled > 0) {
      // 陀螺项实验：把这一步的精确无力矩转动换算成等效恒定角速度交给 Rapier（不施加力、不设定朝向）
      const mp = this.bursted ? this.massPropsNoBlade : this.massProps;
      body.setAngvel(gyroStep(wNew, up, mp.Ia, mp.It, dt, this.gyroState), true);
    } else body.setAngvel(wNew, true);
    this.spin = mag;
    this.ledgerWritten = mag;
  }

  /** 已爆裂（Blade 已脱离） */
  bursted = false;

  /**
   * 爆裂：Blade 从刚体上脱离（移除刀刃碰撞体，Rapier 按剩余碰撞体重算质量），剩下的 Ratchet + Bit 失去驱动并很快停转。
   * 只在规则判定爆裂之后调用；表现层另外播放 Blade 飞出的动画。
   */
  burstApart(): void {
    if (this.bursted) return;
    this.bursted = true;
    const i = this.colliders.indexOf(this.bladeCollider);
    if (i >= 0) this.colliders.splice(i, 1);
    this.pw.world.removeCollider(this.bladeCollider, true);
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
    this.ledger.smash += Math.abs(delta);
    this.ledgerSmash += Math.abs(delta);
    this.body.setAngvel({ x: w.x - up.x * delta, y: w.y - up.y * delta, z: w.z - up.z * delta }, true);
  }

  dispose(): void {
    this.pw.world.removeRigidBody(this.body);
  }
}
