import { describe, expect, it } from 'vitest';
import { describeOutcome, FINISH_POINTS, Match, MATCH_RULES, RoundJudge, type RoundOutcome, type SideObservation } from '../src/game/battle/match';

const DT = 1 / 120;
const live = (spin = 100): SideObservation => ({ out: null, backInArena: true, stopped: false, toppled: false, burst: false, sinceContact: 0, spin });

/** 按时间线推进：script(t) 返回本步双方观测 */
function run(script: (t: number) => { player: SideObservation; rival: SideObservation }, maxT = 70, rules = {}): RoundOutcome | null {
  const j = new RoundJudge(rules);
  for (let i = 1; i <= Math.round(maxT / DT); i++) {
    const o = j.step(DT, script(i * DT));
    if (o) return o;
  }
  return null;
}

describe('回合裁判：四种终结与分值（v2.0 §6.5）', () => {
  it('分值 1 / 2 / 2 / 3；先到 4 分', () => {
    expect(FINISH_POINTS).toEqual({ spin: 1, over: 2, burst: 2, xtreme: 3 });
    expect(MATCH_RULES.target).toBe(4);
    expect(MATCH_RULES.roundTimeLimit).toBe(60);
  });

  it('自转终结：停转持续超过 0.5 s 才确认（与旧规则 stoppedFor > 0.5 s 同一步）', () => {
    let stopAt = 0;
    const o = run((t) => {
      const stopped = t >= 10;
      if (stopped && !stopAt) stopAt = t;
      return { player: live(), rival: { ...live(stopped ? 1 : 100), stopped } };
    })!;
    expect(o).toMatchObject({ kind: 'win', winner: 'player', loser: 'rival', finish: 'spin', points: 1, cause: 'finish', own: false });
    // 旧规则：每个停转步累加一个步长，累计严格大于 0.5 的那一步确认
    let acc = 0;
    let k = 0;
    while (!(acc > 0.5)) {
      acc += DT;
      k++;
    }
    expect(Math.round((o.time - stopAt) / DT)).toBe(k - 1);
    // 发起时刻 = 第一个停转步开始时；确认时已持续 k 个步长
    expect(Math.round((o.time - o.initiatedAt) / DT)).toBe(k);
  });

  it('出界 / 极限终结：发起后 0.5 s 内回到战斗区且仍在转 → 视为从未发起', () => {
    const j = new RoundJudge();
    let o: RoundOutcome | null = null;
    for (let i = 1; i <= 2400 && !o; i++) {
      const t = i * DT;
      const inPocket = t >= 5 && t < 5.3; // 0.3 s 后弹回
      o = j.step(DT, { player: live(), rival: { ...live(), out: inPocket ? 'xtreme' : null, backInArena: !inPocket } });
    }
    expect(o).toBeNull(); // 20 s 内没有被判极限终结
    expect(j.cancelled).toBe(1);
    expect(j.pending.rival).toBeNull();
  });

  it('极限终结：确认后对方得 3 分；发起前 1.5 s 内接触过（不是自灭）', () => {
    const o = run((t) => ({ player: live(), rival: { ...live(), out: t >= 5 ? 'xtreme' : null, backInArena: t < 5, sinceContact: 0.2 } }))!;
    expect(o).toMatchObject({ kind: 'win', winner: 'player', finish: 'xtreme', points: 3, own: false });
    // 第一次观测到进袋的是结束于 t = 5 的那一步：发起时刻为该步开始时
    expect(o.initiatedAt).toBeCloseTo(5 - DT, 6);
    expect(o.time - o.initiatedAt).toBeGreaterThan(MATCH_RULES.confirmWindow);
    expect(o.time - o.initiatedAt).toBeLessThan(MATCH_RULES.confirmWindow + 1.5 * DT);
  });

  it('自灭：出界前 1.5 s 内没有与对手接触 → 对方只得 1 分', () => {
    const o = run((t) => ({ player: live(), rival: { ...live(), out: t >= 3 ? 'over' : null, backInArena: t < 3, sinceContact: Infinity } }))!;
    expect(o).toMatchObject({ kind: 'win', winner: 'player', finish: 'over', points: 1, own: true });
  });

  it('爆裂终结：不可逆，确认后对方得 2 分', () => {
    const o = run((t) => ({ player: { ...live(), burst: t >= 7 }, rival: live() }))!;
    expect(o).toMatchObject({ kind: 'win', winner: 'rival', loser: 'player', finish: 'burst', points: 2 });
  });

  it('优先级：停转中又被打进口袋 → 按口袋终结（发起时刻按最早的停转）；口袋中爆裂 → 爆裂', () => {
    const a = run((t) => ({ player: live(), rival: { ...live(1), stopped: t >= 5, out: t >= 5.2 ? 'xtreme' : null, backInArena: t < 5.2, sinceContact: 0.1 } }))!;
    expect(a).toMatchObject({ finish: 'xtreme', points: 3 });
    expect(a.initiatedAt).toBeCloseTo(5 - DT, 6);
    const b = run((t) => ({ player: live(), rival: { ...live(), out: t >= 5 ? 'over' : null, backInArena: t < 5, burst: t >= 5.1, sinceContact: 0 } }))!;
    expect(b).toMatchObject({ finish: 'burst', points: 2 });
  });

  it('同时终结：双方在同一 0.5 s 窗口内都发起 → 平局重赛；先后超过窗口 → 先发起者为准', () => {
    const d = run((t) => ({ player: { ...live(), stopped: t >= 10 }, rival: { ...live(), burst: t >= 10.3 } }))!;
    expect(d).toMatchObject({ kind: 'draw', points: 0, cause: 'simultaneous', winner: null });
    const w = run((t) => ({ player: { ...live(), stopped: t >= 10 }, rival: { ...live(), burst: t >= 10.6 } }))!;
    expect(w).toMatchObject({ kind: 'win', winner: 'rival', finish: 'spin' });
  });

  it('超时（60 s）：自转高者胜，自转终结 1 分；转速相同平局', () => {
    const o = run(() => ({ player: live(40), rival: live(55) }))!;
    expect(o).toMatchObject({ kind: 'win', winner: 'rival', finish: 'spin', points: 1, cause: 'timeout' });
    // 旧规则同样是“时间严格超过上限”的那一步判定
    expect(o.time).toBeGreaterThan(60);
    expect(o.time).toBeLessThan(60 + 1.5 * DT);
    const tie = run(() => ({ player: live(50), rival: live(50.2) }))!;
    expect(tie).toMatchObject({ kind: 'draw', cause: 'timeout-tie' });
    const long = run(() => ({ player: live(40), rival: live(55) }), 130, { roundTimeLimit: 120 })!;
    expect(long.time).toBeGreaterThan(120);
    expect(long.time).toBeLessThan(120 + 1.5 * DT);
  });

  it('倾倒停转记为“失衡倒下”，不是“被击倒”', () => {
    const o = run((t) => ({ player: live(), rival: { ...live(8), stopped: t >= 4, toppled: t >= 4 } }))!;
    expect(o.toppled).toBe(true);
    expect(describeOutcome(o, { player: '森衡', rival: '磐盾' })).toBe('磐盾 失衡倒下，森衡 转到了最后');
  });
});

describe('比赛：先到 4 分（v2.0 §6.5）', () => {
  const win = (winner: 'player' | 'rival', finish: 'spin' | 'over' | 'burst' | 'xtreme', own = false): RoundOutcome => ({
    kind: 'win',
    winner,
    loser: winner === 'player' ? 'rival' : 'player',
    finish,
    points: own ? 1 : FINISH_POINTS[finish],
    own,
    toppled: false,
    cause: 'finish',
    time: 10,
    initiatedAt: 9.5,
  });
  const draw: RoundOutcome = { kind: 'draw', winner: null, loser: null, finish: null, points: 0, own: false, toppled: false, cause: 'simultaneous', time: 5, initiatedAt: 4.5 };

  it('比分累计、平局不计分、3–3 决胜轮、到 4 分结束且不再接受回合', () => {
    const m = new Match();
    m.record(win('player', 'xtreme'));
    m.record(win('rival', 'burst'));
    m.record(draw);
    expect(m.score).toEqual({ player: 3, rival: 2 });
    expect(m.decider).toBe(false);
    m.record(win('rival', 'spin'));
    expect(m.score).toEqual({ player: 3, rival: 3 });
    expect(m.decider).toBe(true);
    expect(m.roundNumber).toBe(5);
    m.record(win('player', 'over', true)); // 自灭只得 1 分
    expect(m.score).toEqual({ player: 4, rival: 3 });
    expect(m.over).toBe(true);
    expect(m.winner).toBe('player');
    expect(() => m.record(win('rival', 'spin'))).toThrow();
  });

  it('分值可以越过 4（3 分 + 3 分 = 6），先到者胜', () => {
    const m = new Match();
    m.record(win('rival', 'xtreme'));
    m.record(win('rival', 'xtreme'));
    expect(m.score.rival).toBe(6);
    expect(m.winner).toBe('rival');
  });

  it('结算文案：每种终结一句话', () => {
    const n = { player: '烈刃', rival: '紫曜' };
    expect(describeOutcome(win('player', 'burst'), n)).toBe('烈刃 击爆了 紫曜');
    expect(describeOutcome(win('player', 'xtreme'), n)).toBe('烈刃 把 紫曜 打进了极限口袋');
    expect(describeOutcome(win('player', 'over', true), n)).toContain('自灭');
    expect(describeOutcome(draw, n)).toContain('平局');
  });
});
