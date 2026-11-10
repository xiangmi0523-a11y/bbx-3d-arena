import { describe, expect, it } from 'vitest';
import type { FinishType, RoundOutcome } from '../src/game/battle/match';
import { SIGNATURES } from '../src/game/beys/parts/catalog';
import {
  ALL_PART_KEYS,
  applyClear,
  arenaUnlockLevel,
  CHALLENGES,
  conditionText,
  evaluateChallenge,
  levelAvailable,
  missingParts,
  nextLevel,
  ownedLoadout,
  ownsLoadout,
  partUnlockLevel,
  STARTER_PARTS,
  type Progress,
} from '../src/game/modes/challenge';

/** 挑战模式与收集（v2.0 §8.2 / §9.1）：关卡表、通关判定、奖励与解锁、存档里的拥有关系 */

const fresh = (): Progress => ({ parts: [...STARTER_PARTS], arenas: ['standard'], cleared: [], titles: [], points: 0 });

const win = (finish: FinishType, time: number, winner: 'player' | 'rival' = 'player'): { outcome: RoundOutcome } => ({
  outcome: { kind: 'win', winner, loser: winner === 'player' ? 'rival' : 'player', finish, points: 1, own: false, toppled: false, cause: 'finish', time, initiatedAt: time - 0.5 },
});
const draw = (time = 30): { outcome: RoundOutcome } => ({ outcome: { kind: 'draw', winner: null, loser: null, finish: null, points: 0, own: false, toppled: false, cause: 'simultaneous', time, initiatedAt: time } });

describe('挑战模式：关卡表与 v2.0 §8.2 一致', () => {
  it('10 关：对手、AI 难度、奖励逐关对应；关卡难度只改 AI 参数', () => {
    expect(CHALLENGES.map((c) => c.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(CHALLENGES.map((c) => c.rival)).toEqual(['pandun', 'senheng', 'lieren', 'ziyao', 'pandun', 'lieren', 'senheng', 'ziyao', 'lieren', 'senheng']);
    expect(CHALLENGES.map((c) => c.ai)).toEqual(['rookie', 'rookie', 'rookie', 'pro', 'pro', 'pro', 'pro', 'master', 'master', 'master']);
    expect(CHALLENGES.every((c) => c.arena === 'standard')).toBe(true);
    const rw = CHALLENGES.map((c) => (c.reward.kind === 'part' ? `${c.reward.part}:${c.reward.id}` : c.reward.kind === 'arena' ? `arena:${c.reward.id}` : `title:${c.reward.title}`));
    expect(rw).toEqual(['blade:tidal-bastion', 'ratchet:ring-guard', 'bit:needle-point', 'blade:titan-crown', 'arena:velocity', 'ratchet:tri-lock', 'bit:dome-ball', 'title:持久猎手', 'arena:sky', 'title:竞技场之王']);
    for (const c of CHALLENGES) expect(conditionText(c.condition).length).toBeGreaterThan(3);
  });

  it('初始拥有烈刃与森衡的 6 个零件；6 个奖励零件补齐全部 12 个；磐盾与紫曜的零件全部来自挑战', () => {
    expect(STARTER_PARTS.length).toBe(6);
    const all = new Set([...STARTER_PARTS, ...CHALLENGES.filter((c) => c.reward.kind === 'part').map((c) => (c.reward.kind === 'part' ? `${c.reward.part}:${c.reward.id}` : ''))]);
    expect([...all].sort()).toEqual([...ALL_PART_KEYS].sort());
    const p = fresh();
    expect(ownsLoadout(p, SIGNATURES.lieren.loadout)).toBe(true);
    expect(ownsLoadout(p, SIGNATURES.senheng.loadout)).toBe(true);
    expect(ownsLoadout(p, SIGNATURES.pandun.loadout)).toBe(false);
    expect(ownsLoadout(p, SIGNATURES.ziyao.loadout)).toBe(false);
    expect(missingParts(p, SIGNATURES.pandun.loadout).map((m) => m.level)).toEqual([1, 2, 3]);
    expect(missingParts(p, SIGNATURES.ziyao.loadout).map((m) => m.level)).toEqual([4, 6, 7]);
    expect(partUnlockLevel('blade', 'blaze-fang')).toBeNull();
    expect(arenaUnlockLevel('velocity')).toBe(5);
    expect(arenaUnlockLevel('sky')).toBe(9);
  });
});

describe('挑战模式：通关判定（按决胜回合）', () => {
  const L = (n: number) => CHALLENGES[n - 1];
  it('无条件关：赢下比赛即通关，输了不通关', () => {
    expect(evaluateChallenge(L(1), { winner: 'player', rounds: [win('spin', 12), win('over', 8)] }).cleared).toBe(true);
    expect(evaluateChallenge(L(1), { winner: 'rival', rounds: [win('spin', 12, 'rival')] }).cleared).toBe(false);
  });

  it('“以爆裂终结获胜”：决胜回合必须是爆裂；前面回合的爆裂不算', () => {
    expect(evaluateChallenge(L(5), { winner: 'player', rounds: [win('spin', 10), win('burst', 7)] }).cleared).toBe(true);
    const v = evaluateChallenge(L(5), { winner: 'player', rounds: [win('burst', 7), win('spin', 14)] });
    expect(v.won).toBe(true);
    expect(v.conditionMet).toBe(false);
    expect(v.cleared).toBe(false);
  });

  it('“以出界或极限终结获胜”：两种都算', () => {
    expect(evaluateChallenge(L(6), { winner: 'player', rounds: [win('over', 9)] }).cleared).toBe(true);
    expect(evaluateChallenge(L(6), { winner: 'player', rounds: [win('xtreme', 9)] }).cleared).toBe(true);
    expect(evaluateChallenge(L(6), { winner: 'player', rounds: [win('burst', 9)] }).cleared).toBe(false);
  });

  it('“回合时长 > 20 s”：决胜回合超过 20 秒；第 7 关还要求自转终结', () => {
    expect(evaluateChallenge(L(4), { winner: 'player', rounds: [win('spin', 21.5)] }).cleared).toBe(true);
    expect(evaluateChallenge(L(4), { winner: 'player', rounds: [win('spin', 19)] }).cleared).toBe(false);
    expect(evaluateChallenge(L(4), { winner: 'player', rounds: [win('burst', 25)] }).cleared).toBe(true);
    expect(evaluateChallenge(L(7), { winner: 'player', rounds: [win('burst', 25)] }).cleared).toBe(false);
    expect(evaluateChallenge(L(7), { winner: 'player', rounds: [win('spin', 25)] }).cleared).toBe(true);
  });

  it('“在 3 回合内获胜”：平局重赛也算回合', () => {
    expect(evaluateChallenge(L(8), { winner: 'player', rounds: [win('xtreme', 5), win('spin', 9)] }).cleared).toBe(true);
    expect(evaluateChallenge(L(8), { winner: 'player', rounds: [draw(), win('burst', 6), win('burst', 7)] }).cleared).toBe(true);
    expect(evaluateChallenge(L(8), { winner: 'player', rounds: [draw(), win('spin', 9), win('spin', 9), win('spin', 9)] }).cleared).toBe(false);
  });
});

describe('挑战模式：奖励、解锁与存档', () => {
  it('逐关开放：第 1 关初始开放，其余要求通关上一关', () => {
    const p = fresh();
    expect(levelAvailable(p, 1)).toBe(true);
    expect(levelAvailable(p, 2)).toBe(false);
    expect(nextLevel(p, 1)).toBeNull();
    const after = applyClear(p, CHALLENGES[0]).progress;
    expect(levelAvailable(after, 2)).toBe(true);
    expect(nextLevel(after, 1)).toBe(2);
    expect(nextLevel({ cleared: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }, 10)).toBeNull();
  });

  it('首次通关发放奖励与积分；重复通关不重复发放（幂等）；不修改传入的进度', () => {
    const p = fresh();
    const a = applyClear(p, CHALLENGES[0]);
    expect(a.firstClear).toBe(true);
    expect(a.progress.parts).toContain('blade:tidal-bastion');
    expect(a.progress.points).toBe(100);
    expect(a.reward).toContain('潮汐堡垒');
    expect(p.parts).not.toContain('blade:tidal-bastion');
    const b = applyClear(a.progress, CHALLENGES[0]);
    expect(b.firstClear).toBe(false);
    expect(b.progress).toBe(a.progress);
    expect(b.points).toBe(0);
    const t = applyClear(a.progress, CHALLENGES[7]);
    expect(t.progress.titles).toEqual(['持久猎手']);
    expect(t.progress.points).toBe(400);
    const ar = applyClear(a.progress, CHALLENGES[4]);
    expect(ar.progress.arenas).toEqual(['standard', 'velocity']);
  });

  it('打通 1–7 关后拥有全部 12 个零件，磐盾与紫曜的签名构筑可用', () => {
    let p = fresh();
    for (let i = 0; i < 7; i++) p = applyClear(p, CHALLENGES[i]).progress;
    expect([...p.parts].sort()).toEqual([...ALL_PART_KEYS].sort());
    expect(ownsLoadout(p, SIGNATURES.pandun.loadout)).toBe(true);
    expect(ownsLoadout(p, SIGNATURES.ziyao.loadout)).toBe(true);
  });

  it('读档时把未拥有的零件逐个换回已拥有的零件（不影响已拥有的部分）', () => {
    const p = fresh();
    const fb = SIGNATURES.senheng.loadout;
    expect(ownedLoadout(p, { blade: 'titan-crown', ratchet: 'quad-edge', bit: 'needle-point' }, fb)).toEqual({ blade: fb.blade, ratchet: 'quad-edge', bit: fb.bit });
    expect(ownedLoadout(p, SIGNATURES.lieren.loadout, fb)).toEqual(SIGNATURES.lieren.loadout);
  });
});
