import { ARENA, pocketAtAngle } from '../arena/arenaSpec';
import { TABLE_Y } from '../arena/ArenaPhysics';
import { BEY_TUNING, BeyPhysics } from '../beys/BeyPhysics';
import type { AssembledBey } from '../beys/parts/assemble';
import type { AiLevel } from '../beys/motionIntent';
import { computeLaunch, type Side } from '../launcher/launch';
import type { LaunchCommand } from '../launcher/PullStringGesture';
import { BEY_COLLIDER_PARTS, type ContactSubject } from '../physics/ContactService';
import { PHYSICS_DT, type PhysicsWorld } from '../physics/PhysicsWorld';
import { BURST_TUNING, BurstObserver } from './burst';
import { ContactFeedback, type ContactSample, type ImpactDecision } from './contactFeedback';
import { boundingRadius, canSkip, classifyContact, emptyEvidence, queryContact, type ContactClass, type ContactEvidence } from './contactSampling';
import { impactTier, type ImpactTier } from './impactTiers';
import { RoundJudge, type FinishType, type MatchRules, type RoundCause, type SideObservation } from './match';

export { FINISH_LABEL, FINISH_POINTS, type FinishType } from './match';

/** 一个回合的结果（比赛层的累计见 match.ts） */
export interface BattleResult {
  kind: 'win' | 'draw';
  winner: Side | null;
  loser: Side | null;
  finish: FinishType | null;
  /** 胜方得分（平局 0；自灭 1） */
  points: number;
  own: boolean;
  toppled: boolean;
  cause: RoundCause;
  /** 判定时刻（秒） */
  duration: number;
}

/** 爆裂事件（表现层用：Blade 沿撞击方向飞出） */
export interface BurstEvent {
  side: Side;
  time: number;
  /** 接触点（世界坐标）与飞出方向（水平单位向量，背离对手） */
  x: number;
  y: number;
  z: number;
  dx: number;
  dz: number;
}

/** 终结判定的物理阈值（数值与 v1 相同） */
export const FINISH_TUNING = {
  /** 停转：转速低于它 */
  stopSpin: 2.5,
  /** 倾倒：倾角大于它且转速低于 toppleSpin */
  toppleTilt: 1.1,
  toppleSpin: 12,
  /** 离开战斗区：半径超过场地半径 + outMargin，或掉到台面附近 */
  outMargin: 0.35,
  /** 口袋识别的最大半径余量 */
  pocketReach: 2.2,
};

export interface ImpactEvent {
  /** 冲击强度 0..1 */
  strength: number;
  x: number;
  y: number;
  z: number;
  /** 撞击法线（水平，从 player 指向 rival） */
  nx: number;
  nz: number;
  /** 轻擦 / 中等 / 猛撞 */
  tier: ImpactTier;
  /** 碰撞前一刻的法向接近速度（m/s） */
  approach: number;
  /** 本次碰撞的总冲量（Rapier 接触冲量 + 刀刃咬合冲量，N·s） */
  impulse: number;
  /** 冲量折算的相对速度变化（m/s） */
  dvRel: number;
  /** 所属接触段（与持续摩擦共用同一生命周期，见 contactFeedback） */
  episode: number;
  /** play = 播放反馈；merge = 同一接触段内紧跟着的更弱强碰撞，物理照常但不重复播放 */
  feedback: ImpactDecision;
}

/**
 * 撞击调参（P2.2 重做）。
 *
 * 诊断发现 P2.1 的问题：
 *  - 引擎反弹（恢复系数 ~0.45）之上又按接近速度再补一份分离速度，有效恢复系数 1.3~2.7，
 *    碰撞后两台陀螺弹开得比撞进来还快——像塑料球，没有重量；
 *  - 额外冲量按各自质量缩放，导致轻重陀螺被弹开的速度完全一样，重量差异消失；
 *  - 轻轻贴上也会被推开（引擎冲量≈0，额外冲量却有 3 N·s）。
 *
 * P2.2：碰撞的正常反弹完全交给 Rapier（低恢复系数，金属对撞不弹），
 * 游戏只补充刚体引擎不模拟的“刀刃咬合”：两刀刃接触面的相对滑动速度（主要来自转速）
 * 通过刀刃凸起转成冲量。冲量成对施加（牛顿第三定律），按真实质量分配速度变化，
 * 并作用在接触点上，转速损失和撞后摆动由刚体角动量自然产生。
 */
export const SMASH_TUNING = {
  /** 刀刃咬合把接触面滑动速度转成法向冲量的比例 */
  normal: 0.05,
  /** 转成切向冲量的比例（侧推 + 转速损失） */
  tangent: 0.045,
  /** 接触面滑动速度上限（m/s） */
  slideCap: 90,
  /** 咬合程度随接近速度：(approach + base) / ref，限制在 [min, 1] */
  engageBase: 0.4,
  engageRef: 5,
  engageMin: 0.35,
  /** 刀刃碰撞的摩擦损失：掉速 = spinLoss × 冲量 × 刀刃半径 / 转动惯量 */
  spinLoss: 0.19,
  /** 两次撞击结算的最短间隔（秒）；连续撞击各自独立结算 */
  cooldown: 0.07,
  /** 力度：总冲量折算的相对速度变化达到该值（m/s）即满力度 */
  strengthRef: 12,
  /** 低于该相对速度变化（m/s）的接触算“贴身摩擦”，照常结算物理但不产生撞击反馈 */
  minEventDv: 0.9,
};

/**
 * 实验臂开关（M5 筛选实验用）。默认值与基线逐位等价，不进参数指纹；某一臂经预注册规则采用后，
 * 再并入 SMASH_TUNING 并重新生成 golden。
 *  - approachK：咬合法向冲量的接近速度一次项（v2.0 §6.1 / G14 修正方向：正撞应显著高于同滑移速度的轻擦），
 *    jn += μ × approachK × bite × 接近速度。0 = 基线。
 */
export const SMASH_EXPERIMENT = { approachK: 0 };

/**
 * 一场对战：管理两台陀螺的物理实体、撞击结算和胜负判定。
 * 不依赖 Three.js，可以在 Node 里做无头模拟测试。
 */
export class BattleSystem {
  readonly beys: Partial<Record<Side, BeyPhysics>> = {};
  readonly impacts: ImpactEvent[] = [];
  time = 0;
  hits = 0;
  /** 贴身摩擦接触次数（不产生撞击反馈） */
  grinds = 0;
  result: BattleResult | null = null;
  /** 接触反馈（轻擦 / 持续摩擦 / 强碰撞共用的接触生命周期）。只读物理，不施加力 */
  readonly contact = new ContactFeedback();
  /** 诊断：本场查询接触流形的物理步数 */
  contactQueries = 0;
  /** 本步接触观测（只读）：原始证据与分类，各维度独立；未采样的步 valid = false */
  readonly contactEvidence: ContactEvidence = emptyEvidence();
  contactClass: ContactClass = classifyContact(this.contactEvidence);
  /** 诊断计数（步）：包围球门槛跳过、几何接触、预测间隙、冲量响应、几何接触但零冲量、有冲量但无几何接触 */
  readonly contactStats = { skipped: 0, geometric: 0, predictive: 0, impulse: 0, geometricZeroImpulse: 0, impulseNoGeometric: 0 };
  /** 两台刚体的包围球半径（首次采样时由碰撞体计算） */
  private bound: { a: BeyPhysics; b: BeyPhysics; ra: number; rb: number } | null = null;
  private readonly sample: ContactSample = { touching: false, force: 0, slide: 0, x: 0, y: 0, z: 0, nx: 1, nz: 0, tx: 0, tz: 1 };
  private lastHit = -1;
  private readonly pw: PhysicsWorld;
  private readonly specs: Record<Side, AssembledBey>;
  /** 物理步之前的线速度：Rapier 求解碰撞后两者已经分开，接近速度必须用碰撞前的值 */
  private readonly preVel: Record<Side, { x: number; z: number }> = { player: { x: 0, z: 0 }, rival: { x: 0, z: 0 } };

  /** 回合终结判定（发起 / 确认两时刻，见 match.ts） */
  readonly judgeRound: RoundJudge;
  /**
   * 爆裂（v2.0 §6.3）：接触段 + 应力。只读 ContactService 的身体级法向冲量；
   * PhysicsWorld 没有开启 ContactService 时为 null（不判定爆裂，只用于无观测的对照测试）。
   */
  readonly burst: BurstObserver | null;
  readonly bursts: BurstEvent[] = [];
  /** 最近一次与对手确认接触（法向冲量 > 0）的时刻；从未接触为 -Infinity */
  lastContact = -Infinity;
  private stepIndex = 0;

  /**
   * contactFeedback = false 时不读取接触反馈（只给“读取接触不改变物理”的对照测试用）；
   * rules 覆盖回合规则（例如诊断用 120 s 上限）；kBurst 覆盖爆裂系数（undefined = BURST_TUNING.kBurst）。
   */
  constructor(
    pw: PhysicsWorld,
    specs: Record<Side, AssembledBey>,
    opts: { contactFeedback?: boolean; rules?: Partial<MatchRules>; kBurst?: number | null; ai?: Partial<Record<Side, AiLevel>> } = {},
  ) {
    this.pw = pw;
    this.specs = specs;
    this.ai = opts.ai ?? {};
    this.sampling = opts.contactFeedback !== false;
    this.judgeRound = new RoundJudge(opts.rules);
    const res = (s: AssembledBey) => ({ lock: s.ratchet.lock, burstGuard: s.bit.burstGuard });
    this.burst = pw.contacts ? new BurstObserver(PHYSICS_DT, [res(specs.player), res(specs.rival)], opts.kBurst === undefined ? BURST_TUNING.kBurst : opts.kBurst) : null;
    // 只读接触观测：告诉 ContactService 哪些碰撞体属于哪一台（只读 beys，不改变任何状态）
    const cs = pw.contacts;
    if (cs) {
      const subjects: (ContactSubject | null)[] = [null, null];
      cs.setSubjects(() => {
        const p = this.beys.player;
        const r = this.beys.rival;
        if (subjects[0]?.colliders !== p?.colliders) subjects[0] = p ? { owner: 'player', colliders: p.colliders, parts: BEY_COLLIDER_PARTS } : null;
        if (subjects[1]?.colliders !== r?.colliders) subjects[1] = r ? { owner: 'rival', colliders: r.colliders, parts: BEY_COLLIDER_PARTS } : null;
        return subjects;
      });
    }
  }

  private readonly sampling: boolean;
  /** 每一方的 AI 难度（只改决策参数）；省略 = 标准 */
  private readonly ai: Partial<Record<Side, AiLevel>>;
  /** 统计：每一方进入轨道冲刺的次数（只读 BeyPhysics.dashing 的上升沿，结算展示用） */
  readonly dashStarts: Record<Side, number> = { player: 0, rival: 0 };
  private readonly wasDashing: Record<Side, boolean> = { player: false, rival: false };

  launch(side: Side, cmd: LaunchCommand): BeyPhysics {
    this.beys[side]?.dispose();
    const params = computeLaunch(this.specs[side], side, cmd);
    const level = this.ai[side];
    const bey = new BeyPhysics(this.pw, this.specs[side], level ? { ...params, ai: level } : params);
    this.beys[side] = bey;
    // 发射过渡：两台都在场时设定各自的初始倾斜方向（只在第一步之前生效一次）
    const other = this.beys[side === 'player' ? 'rival' : 'player'];
    if (other) {
      bey.alignLaunch(other);
      other.alignLaunch(bey);
    }
    return bey;
  }

  get started(): boolean {
    return !!(this.beys.player && this.beys.rival);
  }

  /** 物理步之前 */
  preStep(dt: number): void {
    for (const side of ['player', 'rival'] as Side[]) {
      const b = this.beys[side];
      if (!b) continue;
      const other = this.beys[side === 'player' ? 'rival' : 'player'];
      b.opponent = other ?? null;
      b.preStep(dt);
      const v = b.body.linvel();
      this.preVel[side].x = v.x;
      this.preVel[side].z = v.z;
    }
  }

  /** 物理步之后：处理撞击、判定胜负 */
  postStep(dt: number): void {
    const a = this.beys.player;
    const b = this.beys.rival;
    if (!a || !b) return;
    this.time += dt;

    // 接触反馈先于撞击结算读取本步接触（只读：接触流形不受 resolveSmash 施加的冲量影响）
    if (this.sampling) this.contact.step(dt, this.sampleContact(a, b, dt));

    for (const pair of this.pw.startedContacts) {
      const hitAB =
        (a.ownsCollider(pair.a) && b.ownsCollider(pair.b)) || (a.ownsCollider(pair.b) && b.ownsCollider(pair.a));
      if (hitAB && this.time - this.lastHit > SMASH_TUNING.cooldown) {
        this.lastHit = this.time;
        const n = this.impacts.length;
        this.resolveSmash(a, b);
        if (this.impacts.length > n) {
          const ev = this.impacts[n];
          ev.episode = this.contact.state.episode;
          ev.feedback = this.contact.impact(ev.tier, ev.strength);
        }
      }
    }

    // 爆裂：实测法向冲量按接触段累积（判定只读观测，不施力）
    this.stepIndex++;
    const cs = this.pw.contacts;
    const bp = cs?.bodyPair('player', 'rival') ?? null;
    const imp = bp?.normalImpulse ?? 0;
    const confirmed = cs ? imp > 0 : this.contactClass.impulseResponse;
    if (confirmed) this.lastContact = this.time;
    if (this.burst && !this.result) {
      const hits = this.burst.step(this.stepIndex, imp, [a.spinRatio, b.spinRatio]);
      for (const i of hits) this.onBurst(i === 0 ? 'player' : 'rival', bp);
    }

    for (const side of ['player', 'rival'] as Side[]) {
      const d = this.beys[side]!.dashing;
      if (d && !this.wasDashing[side]) this.dashStarts[side]++;
      this.wasDashing[side] = d;
    }

    this.watchStall(a, b, dt);
    if (!this.result) this.judge(dt);
  }

  /** 爆裂发生：记录表现事件，Blade 从刚体上脱离（Ratchet + Bit 留下来摇摆至停） */
  private onBurst(side: Side, bp: ReturnType<NonNullable<PhysicsWorld['contacts']>['bodyPair']>): void {
    const bey = this.beys[side]!;
    const other = this.beys[side === 'player' ? 'rival' : 'player']!;
    const p = bey.body.translation();
    const o = other.body.translation();
    const pt = bp?.deepestPair?.deepest ?? null;
    let dx = p.x - o.x;
    let dz = p.z - o.z;
    const l = Math.hypot(dx, dz) || 1;
    dx /= l;
    dz /= l;
    this.bursts.push({ side, time: this.time, x: pt?.x ?? p.x, y: pt?.y ?? p.y + bey.spec.layers.blade.center, z: pt?.z ?? p.z, dx, dz });
    bey.burstApart();
  }

  /** 僵持时长（秒）与触发脱困次数 */
  stallFor = 0;
  breakouts = 0;
  /** 死亡摇摆贴靠时长、冷却与触发次数（诊断） */
  wobbleFor = 0;
  wobbleCool = 0;
  wobbleBreaks = 0;

  /** 两台都几乎不动、贴在一起仍在转：累计一段时间后让双方轴心按脱困牵引拉开 */
  private watchStall(a: BeyPhysics, b: BeyPhysics, dt: number): void {
    const pa = a.body.translation();
    const pb = b.body.translation();
    const va = a.body.linvel();
    const vb = b.body.linvel();
    const d = Math.hypot(pa.x - pb.x, pa.z - pb.z);
    // 第三轮实验：stallBreak 0 时通用僵持不计时、不触发（死亡摇摆分支照常运行）
    const stalled =
      BEY_TUNING.stallBreak > 0 &&
      Math.hypot(va.x, va.z) < 0.8 &&
      Math.hypot(vb.x, vb.z) < 0.8 &&
      d < a.spec.outerRadius + b.spec.outerRadius + 0.4 &&
      a.spin > 10 &&
      b.spin > 10;
    this.stallFor = stalled ? this.stallFor + dt : 0;
    if (this.stallFor > BEY_TUNING.stallTime) {
      this.stallFor = 0;
      this.breakouts++;
      a.breakout = b.breakout = BEY_TUNING.breakoutTime;
      a.intent.forceBreakout(BEY_TUNING.breakoutTime);
      b.intent.forceBreakout(BEY_TUNING.breakoutTime);
    }
    // 死亡摇摆：低转速 + 明显倾斜 + 持续贴靠 + 对方还有余力 → 只让较健康的一台按脱困机制离开
    const T = BEY_TUNING;
    if (T.wobbleBreak > 0) {
      const low = a.spinRatio <= b.spinRatio ? a : b;
      const high = low === a ? b : a;
      const wobbling = isDeathWobble({
        touching: d < a.spec.blade.radius + b.spec.blade.radius + 0.05,
        lowSpin: low.spinRatio,
        lowTiltExcess: low.tilt - low.spec.bit.drift,
        highSpin: high.spinRatio,
        highCanDrive: high.spin > T.minStableSpin * 2,
        highInBreakout: high.breakout > 0,
      });
      this.wobbleFor = wobbling ? this.wobbleFor + dt : 0;
      if (this.wobbleCool > 0) this.wobbleCool -= dt;
      if (this.wobbleFor > T.wobbleTime && this.wobbleCool <= 0) {
        this.wobbleFor = 0;
        this.wobbleCool = T.wobbleCooldown;
        this.wobbleBreaks++;
        this.breakouts++;
        high.breakout = T.breakoutTime;
        high.intent.forceBreakout(T.breakoutTime);
      }
    }
  }

  /**
   * 读取本步两台陀螺之间的接触（只读，见 contactSampling.ts）。
   * 先用包围球门槛排除物理上不可能有接触流形的步（与姿态无关，倾斜的刀刃边缘也覆盖），再查询全部碰撞体对。
   * 原始证据写进 contactEvidence，分类写进 contactClass，二者各维度独立。
   * 交给接触反馈的 touching = 几何接触（求解器 signed distance ≤ 0，包括零冲量穿透）或 求解器给出了法向冲量；
   * 力 = 法向冲量 / 步长（零冲量穿透时为 0）。没有查询的步返回 null。
   */
  private sampleContact(a: BeyPhysics, b: BeyPhysics, dt: number): ContactSample | null {
    const e = this.contactEvidence;
    Object.assign(e, emptyEvidence());
    if (!this.bound || this.bound.a !== a || this.bound.b !== b) {
      const R = this.pw.R;
      this.bound = { a, b, ra: boundingRadius(R, a.colliders), rb: boundingRadius(R, b.colliders) };
    }
    const pa = a.body.translation();
    const pb = b.body.translation();
    const ip = this.pw.world.integrationParameters;
    if (canSkip(pa, pb, a.body.linvel(), b.body.linvel(), this.bound.ra, this.bound.rb, dt, ip.normalizedPredictionDistance * ip.lengthUnit)) {
      e.skipped = 'bound';
      this.contactClass = classifyContact(e);
      this.contactStats.skipped++;
      return null;
    }
    this.contactQueries++;
    queryContact(this.pw.world, a.colliders, b.colliders, e);
    const c = (this.contactClass = classifyContact(e));
    const st = this.contactStats;
    if (c.geometric) st.geometric++;
    if (c.predictive) st.predictive++;
    if (c.impulseResponse) st.impulse++;
    if (c.geometric && !c.impulseResponse) st.geometricZeroImpulse++;
    if (c.impulseResponse && !c.geometric) st.impulseNoGeometric++;
    let nx = pb.x - pa.x;
    let nz = pb.z - pa.z;
    const len = Math.hypot(nx, nz) || 1;
    const s = this.sample;
    s.touching = c.geometric || c.impulseResponse;
    if (!s.touching) return s;
    nx /= len;
    nz /= len;
    const va = a.body.linvel();
    const vb = b.body.linvel();
    const ra = Math.min(a.spec.outerRadius, len / 2);
    const rb = Math.min(b.spec.outerRadius, len / 2);
    const wa = a.spinDirection * a.spin;
    const wb = b.spinDirection * b.spin;
    const ux = va.x + wa * ra * nz - (vb.x - wb * rb * nz);
    const uz = va.z - wa * ra * nx - (vb.z + wb * rb * nx);
    const un = ux * nx + uz * nz;
    const tx = ux - un * nx;
    const tz = uz - un * nz;
    const slide = Math.hypot(tx, tz);
    s.force = e.impulse / dt;
    s.slide = slide;
    s.tx = slide > 1e-6 ? tx / slide : -nz;
    s.tz = slide > 1e-6 ? tz / slide : nx;
    s.nx = nx;
    s.nz = nz;
    s.x = pa.x + nx * ra;
    s.z = pa.z + nz * ra;
    s.y = (pa.y + a.spec.layers.blade.center + pb.y + b.spec.layers.blade.center) / 2;
    return s;
  }

  /** Rapier 本步在两台陀螺之间施加的法向接触冲量总和 */
  private contactImpulse(a: BeyPhysics, b: BeyPhysics): number {
    let sum = 0;
    for (const ca of a.colliders) {
      for (const cb of b.colliders) {
        this.pw.world.contactPair(ca, cb, (m) => {
          for (let i = 0, n = m.numContacts(); i < n; i++) sum += m.contactImpulse(i);
        });
      }
    }
    return sum;
  }

  /**
   * 撞击结算：Rapier 已经按刚体完成了碰撞（低恢复系数），这里补充刀刃咬合冲量。
   * 方向和大小全部来自碰撞前的速度、转速、质量和部件攻防，因此不同组合结果不同。
   */
  private resolveSmash(a: BeyPhysics, b: BeyPhysics): void {
    const T = SMASH_TUNING;
    const pa = a.body.translation();
    const pb = b.body.translation();
    let nx = pb.x - pa.x;
    let nz = pb.z - pa.z;
    const len = Math.hypot(nx, nz) || 1;
    nx /= len;
    nz /= len;
    const va = this.preVel.player;
    const vb = this.preVel.rival;
    const approach = Math.max(0, (va.x - vb.x) * nx + (va.z - vb.z) * nz);
    const ra = Math.min(a.spec.outerRadius, len / 2);
    const rb = Math.min(b.spec.outerRadius, len / 2);
    const ma = a.body.mass();
    const mb = b.body.mass();
    const mu = (ma * mb) / (ma + mb);

    // 接触点处的表面速度：ω ŷ × r。A 的接触点在 +n 方向，B 的在 -n 方向
    const wa = a.spinDirection * a.spin;
    const wb = b.spinDirection * b.spin;
    const ux = va.x + wa * ra * nz - (vb.x - wb * rb * nz);
    const uz = va.z - wa * ra * nx - (vb.z + wb * rb * nx);
    // 切向滑动（去掉法向分量）
    const un = ux * nx + uz * nz;
    let tx = ux - un * nx;
    let tz = uz - un * nz;
    const slide = Math.min(Math.hypot(tx, tz), T.slideCap);
    if (slide > 1e-6) {
      const tl = Math.hypot(tx, tz);
      tx /= tl;
      tz /= tl;
    }

    // 刀刃咬合程度：攻击型刀刃凸起多、咬得深；圆润的防御型刀刃容易滑开
    const bite = Math.max(
      0.15,
      Math.min(1, 0.35 + 0.65 * ((a.spec.blade.attack + b.spec.blade.attack) / 2) - 0.3 * ((a.spec.blade.defense + b.spec.blade.defense) / 2)),
    );
    // 撞得越正、越快，刀刃越能咬住；轻轻擦过只有少量咬合
    const engage = Math.max(T.engageMin, Math.min(1, (approach + T.engageBase) / T.engageRef));
    const jn = SMASH_EXPERIMENT.approachK > 0 ? mu * T.normal * bite * engage * slide + mu * SMASH_EXPERIMENT.approachK * bite * approach : mu * T.normal * bite * engage * slide;
    const jt = mu * T.tangent * bite * engage * slide;

    // 接触点（世界坐标）：刀刃高度。冲量作用在这里，高于质心 → 自然产生撞后摆动
    const cy = (pa.y + a.spec.layers.blade.center + pb.y + b.spec.layers.blade.center) / 2;
    const cx = pa.x + nx * ra;
    const cz = pa.z + nz * ra;
    const ix = nx * jn + tx * jt;
    const iz = nz * jn + tz * jt;
    // 牛顿第三定律：A 受 -I，B 受 +I；速度变化按各自质量分配（重的陀螺被推得少）
    b.body.applyImpulseAtPoint({ x: ix, y: 0, z: iz }, { x: cx, y: cy, z: cz }, true);
    a.body.applyImpulseAtPoint({ x: -ix, y: 0, z: -iz }, { x: cx, y: cy, z: cz }, true);
    // 金属刀刃互相刮擦的摩擦损失：冲量作用在刀刃外缘，角冲量 = 冲量 × 半径，
    // 掉速 = 角冲量 / 转动惯量（惯量大、重量在外缘的陀螺被撞后掉速少）
    const jSmash = Math.hypot(jn, jt);
    a.loseSpin((T.spinLoss * jSmash * ra) / a.spec.spinInertia);
    b.loseSpin((T.spinLoss * jSmash * rb) / b.spec.spinInertia);

    const impulse = this.contactImpulse(a, b) + jSmash;
    const dvRel = impulse / mu;
    const strength = Math.min(1, dvRel / T.strengthRef);
    if (dvRel < T.minEventDv) {
      // 两台陀螺贴在一起互相刮擦：物理照常，但不算一次撞击，避免音效 / 特效连发
      this.grinds++;
      return;
    }
    this.hits++;
    this.impacts.push({
      strength,
      tier: impactTier(strength),
      approach,
      impulse,
      dvRel,
      x: cx,
      y: cy,
      z: cz,
      nx,
      nz,
      episode: 0,
      feedback: 'play',
    });
  }

  /** 一台陀螺本步的终结观测（判定只读这些，阈值见 FINISH_TUNING） */
  observe(bey: BeyPhysics, side: Side): SideObservation {
    const F = FINISH_TUNING;
    const p = bey.body.translation();
    const r = Math.hypot(p.x, p.z);
    let out: SideObservation['out'] = null;
    if (r > ARENA.radius + F.outMargin || p.y < TABLE_Y + 0.5) {
      const pocket = r > ARENA.radius && r < ARENA.radius + F.pocketReach ? pocketAtAngle(Math.atan2(p.z, p.x)) : undefined;
      out = pocket?.kind === 'xtreme' ? 'xtreme' : 'over';
    }
    const toppled = bey.tilt > F.toppleTilt && bey.spin < F.toppleSpin;
    const idx = side === 'player' ? 0 : 1;
    return {
      out,
      backInArena: r < ARENA.radius && bey.spin >= F.stopSpin,
      stopped: bey.spin < F.stopSpin || toppled,
      toppled,
      burst: !!this.burst?.meter.burst.includes(idx),
      sinceContact: this.time - this.lastContact,
      spin: bey.spin,
    };
  }

  private judge(dt: number): void {
    const o = this.judgeRound.step(dt, { player: this.observe(this.beys.player!, 'player'), rival: this.observe(this.beys.rival!, 'rival') });
    if (!o) return;
    this.burst?.finish();
    this.result = { kind: o.kind, winner: o.winner, loser: o.loser, finish: o.finish, points: o.points, own: o.own, toppled: o.toppled, cause: o.cause, duration: o.time };
  }

  dispose(): void {
    this.contact.reset();
    for (const b of Object.values(this.beys)) b?.dispose();
    this.beys.player = undefined;
    this.beys.rival = undefined;
  }
}

/**
 * 死亡摇摆判定（第二轮修正 4）：较弱一台转速比例 < wobbleSpin、实际倾斜比轴心自然倾角大 wobbleTilt 以上、两台刀刃贴着、
 * 较强一台转速比例高出 wobbleMargin 以上且还有牵引能力、不在脱困中。高转速摩擦不满足第一条，低速但竖直的互磨不满足第二条。
 */
export function isDeathWobble(s: { touching: boolean; lowSpin: number; lowTiltExcess: number; highSpin: number; highCanDrive: boolean; highInBreakout: boolean }): boolean {
  const T = BEY_TUNING;
  return s.touching && s.lowSpin < T.wobbleSpin && s.lowTiltExcess > T.wobbleTilt && s.highSpin > s.lowSpin + T.wobbleMargin && s.highCanDrive && !s.highInBreakout;
}
