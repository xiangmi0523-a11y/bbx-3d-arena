/**
 * 回合制比赛规则（产品总方案 v2.0 §6.5）——纯逻辑，不依赖 Rapier / Three.js，可在 Node 里确定性测试。
 *
 * 终结与分值：自转 1 / 出界 2 / 爆裂 2 / 极限 3；先到 4 分者胜（3–3 为决胜轮，规则不变）。
 * 判定优先级：爆裂 > 出界 / 极限 > 自转。
 *
 * “发起”与“确认”两个时刻（官方规则的判定完备性）：
 *  - 发起：陀螺整体进入口袋 / 部件分离（爆裂）/ 停转（转速归零或倾倒）的那一步（发起时刻记为该步开始时）；
 *  - 确认：发起后持续超过 confirmWindow 秒没有被逆转（回到战斗区且仍在转 / 重新转起来）；爆裂不可逆。
 *    持续时间按步长逐步累加、严格大于窗口才确认——与旧版 stoppedFor > 0.5 的判定逐位相同（golden 可比）。
 *  - 已发起但被逆转的终结视为从未发起。
 *  - 同时终结：双方在同一 confirmWindow 窗口内都发起终结 → 平局，本回合重赛、不计分。
 *  - 同一方在窗口内先后发起多种终结时取优先级最高的一种（发起时刻按最早的那次）。
 * 自灭（Own Finish，游戏自定规则，不是官方规则）：出界 / 极限终结发起前 ownFinishWindow 秒内与对手没有确认接触，
 * 对方只得 1 分。
 * 回合超时：回合时间超过 roundTimeLimit 秒仍无终结 → 自转高者胜（自转终结 1 分）；转速几乎相同判平局重赛。
 */
import type { Side } from '../launcher/launch';

export type FinishType = 'spin' | 'over' | 'burst' | 'xtreme';

export const FINISH_POINTS: Record<FinishType, number> = { spin: 1, over: 2, burst: 2, xtreme: 3 };

export const FINISH_LABEL: Record<FinishType, string> = {
  spin: '自转终结',
  over: '出界终结',
  burst: '爆裂终结',
  xtreme: '极限终结',
};

export const MATCH_RULES = {
  /** 先到多少分获胜 */
  target: 4,
  /** 回合时间上限（秒） */
  roundTimeLimit: 60,
  /** 发起 → 确认的时间窗（秒），也是“同时终结”的判定窗口 */
  confirmWindow: 0.5,
  /** 自灭判定：出界 / 极限发起前这么久（秒）内没有与对手确认接触 */
  ownFinishWindow: 1.5,
  /** 超时判定时双方转速相差不到这个比例视为相同（平局重赛） */
  timeoutTieRatio: 0.01,
};

export type MatchRules = typeof MATCH_RULES;

/** 一方本步的观测（由对战系统从物理状态与爆裂系统得出，判定只读这些） */
export interface SideObservation {
  /** 整体离开战斗区：'over' = 出界口袋 / 越过护墙 / 掉出场地；'xtreme' = 极限口袋；仍在场内为 null */
  out: 'over' | 'xtreme' | null;
  /** 回到战斗区（半径 < 场地半径）且仍在转：用于取消已发起的口袋终结 */
  backInArena: boolean;
  /** 停转（转速归零，或倾倒且转速很低） */
  stopped: boolean;
  /** 停转的形态是倾倒（侧翻），结算写“失衡倒下”而不是“被击倒”（v2.0 §6.2） */
  toppled: boolean;
  /** 已爆裂（不可逆） */
  burst: boolean;
  /** 距上次与对手确认接触的时间（秒）；本回合从未接触为 Infinity */
  sinceContact: number;
  /** 当前转速（rad/s），超时判定用 */
  spin: number;
}

export interface PendingFinish {
  kind: FinishType;
  /** 发起时刻（回合内秒数，发起那一步开始时） */
  t0: number;
  /** 已持续的时间（逐步累加步长，含发起那一步） */
  held: number;
  own: boolean;
  toppled: boolean;
}

export type RoundCause = 'finish' | 'timeout' | 'simultaneous' | 'timeout-tie';

export interface RoundOutcome {
  kind: 'win' | 'draw';
  winner: Side | null;
  loser: Side | null;
  finish: FinishType | null;
  /** 胜方得分（平局为 0） */
  points: number;
  /** 自灭：对方只得 1 分 */
  own: boolean;
  /** 自转终结的形态是倾倒 */
  toppled: boolean;
  cause: RoundCause;
  /** 判定（确认）时刻 */
  time: number;
  /** 决定胜负的终结的发起时刻（超时为判定时刻） */
  initiatedAt: number;
}

const SIDES: Side[] = ['player', 'rival'];
const other = (s: Side): Side => (s === 'player' ? 'rival' : 'player');
const PRIORITY: Record<FinishType, number> = { spin: 0, over: 1, xtreme: 1, burst: 2 };

/** 一个回合的终结判定（每个物理步调用一次 step） */
export class RoundJudge {
  time = 0;
  readonly pending: Record<Side, PendingFinish | null> = { player: null, rival: null };
  outcome: RoundOutcome | null = null;
  /** 统计：被逆转（取消）的发起次数 */
  cancelled = 0;
  readonly rules: MatchRules;

  constructor(rules: Partial<MatchRules> = {}) {
    this.rules = { ...MATCH_RULES, ...rules };
  }

  step(dt: number, obs: Record<Side, SideObservation>): RoundOutcome | null {
    if (this.outcome) return this.outcome;
    this.time += dt;
    const t = this.time;
    const R = this.rules;
    for (const s of SIDES) {
      const o = obs[s];
      const p = this.pending[s];
      // 逆转：口袋终结回到战斗区且仍在转、停转后又转起来 —— 视为从未发起（爆裂不可逆）
      if (p && p.kind !== 'burst') {
        const reversed = p.kind === 'spin' ? !o.stopped && !o.out && !o.burst : o.backInArena && !o.burst;
        if (reversed) {
          this.pending[s] = null;
          this.cancelled++;
        }
      }
      const k: FinishType | null = o.burst ? 'burst' : o.out ? o.out : o.stopped ? 'spin' : null;
      if (!k) continue;
      const own = (k === 'over' || k === 'xtreme') && o.sinceContact > R.ownFinishWindow;
      const cur = this.pending[s];
      if (!cur) this.pending[s] = { kind: k, t0: t - dt, held: dt, own, toppled: o.toppled };
      else {
        cur.held += dt;
        if (PRIORITY[k] > PRIORITY[cur.kind]) this.pending[s] = { kind: k, t0: cur.t0, held: cur.held, own, toppled: false };
        else if (PRIORITY[k] === PRIORITY[cur.kind] && k !== cur.kind) cur.kind = k; // 出界口袋 ↔ 极限口袋：以当前所在为准
        else if (k === 'spin' && o.toppled) cur.toppled = true;
      }
    }

    const a = this.pending.player;
    const b = this.pending.rival;
    const first: Side | null = a && b ? (a.t0 <= b.t0 ? 'player' : 'rival') : a ? 'player' : b ? 'rival' : null;
    if (first) {
      const p = this.pending[first]!;
      if (p.held > R.confirmWindow) {
        const q = this.pending[other(first)];
        if (q) this.outcome = { kind: 'draw', winner: null, loser: null, finish: null, points: 0, own: false, toppled: false, cause: 'simultaneous', time: t, initiatedAt: p.t0 };
        else {
          const points = p.own ? 1 : FINISH_POINTS[p.kind];
          this.outcome = { kind: 'win', winner: other(first), loser: first, finish: p.kind, points, own: p.own, toppled: p.kind === 'spin' && p.toppled, cause: 'finish', time: t, initiatedAt: p.t0 };
        }
      }
    } else if (t > R.roundTimeLimit) {
      const sa = obs.player.spin;
      const sb = obs.rival.spin;
      if (Math.abs(sa - sb) <= R.timeoutTieRatio * Math.max(sa, sb, 1e-9))
        this.outcome = { kind: 'draw', winner: null, loser: null, finish: null, points: 0, own: false, toppled: false, cause: 'timeout-tie', time: t, initiatedAt: t };
      else {
        const loser: Side = sa < sb ? 'player' : 'rival';
        this.outcome = { kind: 'win', winner: other(loser), loser, finish: 'spin', points: FINISH_POINTS.spin, own: false, toppled: false, cause: 'timeout', time: t, initiatedAt: t };
      }
    }
    return this.outcome;
  }
}

/** 一场比赛（先到 target 分） */
export class Match {
  readonly score: Record<Side, number> = { player: 0, rival: 0 };
  readonly rounds: RoundOutcome[] = [];
  readonly target: number;

  constructor(target = MATCH_RULES.target) {
    this.target = target;
  }

  get winner(): Side | null {
    if (this.score.player >= this.target) return 'player';
    if (this.score.rival >= this.target) return 'rival';
    return null;
  }

  get over(): boolean {
    return this.winner !== null;
  }

  /** 3–3（双方都差 1 分）：决胜轮 */
  get decider(): boolean {
    return !this.over && this.score.player === this.target - 1 && this.score.rival === this.target - 1;
  }

  /** 下一回合的序号（从 1 开始） */
  get roundNumber(): number {
    return this.rounds.length + 1;
  }

  record(o: RoundOutcome): void {
    if (this.over) throw new Error('比赛已结束');
    this.rounds.push(o);
    if (o.kind === 'win' && o.winner) this.score[o.winner] += o.points;
  }
}

/** 结算屏的一句话（胜负原因）。names：双方显示名 */
export function describeOutcome(o: RoundOutcome, names: Record<Side, string>): string {
  if (o.kind === 'draw') return o.cause === 'timeout-tie' ? '时间到，双方转速相同：平局，重赛本回合' : '双方同时终结：平局，重赛本回合';
  const w = names[o.winner!];
  const l = names[o.loser!];
  switch (o.finish) {
    case 'burst':
      return `${w} 击爆了 ${l}`;
    case 'xtreme':
      return o.own ? `${l} 自己冲进了极限口袋（自灭，${w} 得 1 分）` : `${w} 把 ${l} 打进了极限口袋`;
    case 'over':
      return o.own ? `${l} 自己滑出了场地（自灭，${w} 得 1 分）` : `${w} 把 ${l} 打出了场地`;
    default:
      if (o.cause === 'timeout') return `时间到，${w} 转得更久`;
      return o.toppled ? `${l} 失衡倒下，${w} 转到了最后` : `${l} 停止旋转，${w} 转到了最后`;
  }
}
