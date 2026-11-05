import { ARENA, pocketAtAngle } from '../arena/arenaSpec';
import { TABLE_Y } from '../arena/ArenaPhysics';
import { BEY_TUNING, BeyPhysics } from '../beys/BeyPhysics';
import type { AssembledBey } from '../beys/parts/assemble';
import { computeLaunch, type Side } from '../launcher/launch';
import type { LaunchCommand } from '../launcher/PullStringGesture';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import { impactTier, type ImpactTier } from './impactTiers';

export type FinishType = 'spin' | 'over' | 'xtreme';

export const FINISH_POINTS: Record<FinishType, number> = { spin: 1, over: 2, xtreme: 3 };
export const FINISH_LABEL: Record<FinishType, string> = {
  spin: '旋转终结',
  over: '出界终结',
  xtreme: '极限终结',
};

export interface BattleResult {
  winner: Side;
  loser: Side;
  finish: FinishType;
  points: number;
  duration: number;
}

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
  private lastHit = -1;
  private readonly pw: PhysicsWorld;
  private readonly specs: Record<Side, AssembledBey>;
  private stoppedFor: Record<Side, number> = { player: 0, rival: 0 };
  /** 物理步之前的线速度：Rapier 求解碰撞后两者已经分开，接近速度必须用碰撞前的值 */
  private readonly preVel: Record<Side, { x: number; z: number }> = { player: { x: 0, z: 0 }, rival: { x: 0, z: 0 } };

  constructor(pw: PhysicsWorld, specs: Record<Side, AssembledBey>) {
    this.pw = pw;
    this.specs = specs;
  }

  launch(side: Side, cmd: LaunchCommand): BeyPhysics {
    this.beys[side]?.dispose();
    const bey = new BeyPhysics(this.pw, this.specs[side], computeLaunch(this.specs[side], side, cmd));
    this.beys[side] = bey;
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
      b.target = other ? other.body.translation() : null;
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

    for (const pair of this.pw.startedContacts) {
      const hitAB =
        (a.ownsCollider(pair.a) && b.ownsCollider(pair.b)) || (a.ownsCollider(pair.b) && b.ownsCollider(pair.a));
      if (hitAB && this.time - this.lastHit > SMASH_TUNING.cooldown) {
        this.lastHit = this.time;
        this.resolveSmash(a, b);
      }
    }

    this.watchStall(a, b, dt);
    if (!this.result) this.judge(dt);
  }

  /** 僵持时长（秒）与触发脱困次数 */
  stallFor = 0;
  breakouts = 0;

  /** 两台都几乎不动、贴在一起仍在转：累计一段时间后让双方轴心按脱困牵引拉开 */
  private watchStall(a: BeyPhysics, b: BeyPhysics, dt: number): void {
    const pa = a.body.translation();
    const pb = b.body.translation();
    const va = a.body.linvel();
    const vb = b.body.linvel();
    const d = Math.hypot(pa.x - pb.x, pa.z - pb.z);
    const stalled =
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
    }
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
    const jn = mu * T.normal * bite * engage * slide;
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
    a.recoil = b.recoil = BEY_TUNING.recoilTime;
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
    });
  }

  /** 判断某台陀螺是否已被终结 */
  finishOf(bey: BeyPhysics, side: Side, dt: number): FinishType | null {
    const p = bey.body.translation();
    const r = Math.hypot(p.x, p.z);
    if (r > ARENA.radius + 0.35 || p.y < TABLE_Y + 0.5) {
      const pocket = r > ARENA.radius && r < ARENA.radius + 2.2 ? pocketAtAngle(Math.atan2(p.z, p.x)) : undefined;
      return pocket?.kind === 'xtreme' ? 'xtreme' : 'over';
    }
    const stopped = bey.spin < 2.5 || (bey.tilt > 1.1 && bey.spin < 12);
    this.stoppedFor[side] = stopped ? this.stoppedFor[side] + dt : 0;
    if (this.stoppedFor[side] > 0.5) return 'spin';
    return null;
  }

  private judge(dt: number): void {
    const a = this.beys.player!;
    const b = this.beys.rival!;
    const fa = this.finishOf(a, 'player', dt);
    const fb = this.finishOf(b, 'rival', dt);
    let loser: Side | null = null;
    let finish: FinishType | null = null;
    if (fa && fb) {
      // 同时终结：出界优先于旋转终结；都一样则比较剩余转速
      loser = FINISH_POINTS[fa] >= FINISH_POINTS[fb] ? 'player' : 'rival';
      if (fa === fb) loser = a.spin <= b.spin ? 'player' : 'rival';
      finish = loser === 'player' ? fa : fb;
    } else if (fa) {
      loser = 'player';
      finish = fa;
    } else if (fb) {
      loser = 'rival';
      finish = fb;
    } else if (this.time > 120) {
      loser = a.spin < b.spin ? 'player' : 'rival';
      finish = 'spin';
    }
    if (loser && finish) {
      const winner: Side = loser === 'player' ? 'rival' : 'player';
      this.result = { winner, loser, finish, points: FINISH_POINTS[finish], duration: this.time };
    }
  }

  dispose(): void {
    for (const b of Object.values(this.beys)) b?.dispose();
    this.beys.player = undefined;
    this.beys.rival = undefined;
  }
}
