import { ARENA, pocketAtAngle } from '../arena/arenaSpec';
import { TABLE_Y } from '../arena/ArenaPhysics';
import { BeyPhysics } from '../beys/BeyPhysics';
import type { AssembledBey } from '../beys/parts/assemble';
import { computeLaunch, type Side } from '../launcher/launch';
import type { LaunchCommand } from '../launcher/PullStringGesture';
import type { PhysicsWorld } from '../physics/PhysicsWorld';

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
}

export const SMASH_TUNING = {
  /** 接近速度对冲量的贡献 */
  approach: 0.55,
  /** 接触面相对线速度（来自转速）的贡献 */
  surface: 0.03,
  /** 总体倍率 */
  scale: 1.8,
  /** 切向（转速带来的侧推）比例 */
  tangential: 0.45,
  /** 每次撞击的转速损失系数 */
  spinLoss: 1.6,
  cooldown: 0.12,
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
  result: BattleResult | null = null;
  private lastHit = -1;
  private readonly pw: PhysicsWorld;
  private readonly specs: Record<Side, AssembledBey>;
  private stoppedFor: Record<Side, number> = { player: 0, rival: 0 };

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
    for (const b of Object.values(this.beys)) b?.preStep(dt);
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

    if (!this.result) this.judge(dt);
  }

  /**
   * 撞击结算：在物理引擎已经处理完刚体碰撞后，再根据转速差和部件攻防补一份冲量。
   * 方向来自两者实际位置，大小来自实际速度和转速，因此仍由物理状态驱动。
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
    const va = a.body.linvel();
    const vb = b.body.linvel();
    const approach = Math.max(0, (va.x - vb.x) * nx + (va.z - vb.z) * nz);
    const ra = a.spec.outerRadius;
    const rb = b.spec.outerRadius;
    // 同向旋转时接触面反向运动，相对线速度相加；反向旋转时相减
    const same = a.spinDirection === b.spinDirection;
    const surface = same ? a.spin * ra + b.spin * rb : Math.abs(a.spin * ra - b.spin * rb);
    const base = (T.approach * approach + T.surface * surface) * T.scale;

    // 切向：A 的接触点表面速度方向（ω × n）
    const tx = -a.spinDirection * -nz;
    const tz = -a.spinDirection * nx;

    const toB = base * (0.5 + a.spec.blade.attack) * (1 - b.spec.blade.defense * 0.55);
    const toA = base * (0.5 + b.spec.blade.attack) * (1 - a.spec.blade.defense * 0.55);
    const mb = b.body.mass();
    const ma = a.body.mass();
    b.applyImpulse((nx + tx * T.tangential) * toB * mb, 0.15 * toB * mb, (nz + tz * T.tangential) * toB * mb);
    a.applyImpulse((-nx - tx * T.tangential) * toA * ma, 0.15 * toA * ma, (-nz - tz * T.tangential) * toA * ma);
    b.loseSpin(toB * T.spinLoss);
    a.loseSpin(toA * T.spinLoss);

    this.hits++;
    this.impacts.push({
      strength: Math.min(1, base / 6),
      x: (pa.x + pb.x) / 2,
      y: (pa.y + pb.y) / 2 + 0.3,
      z: (pa.z + pb.z) / 2,
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
