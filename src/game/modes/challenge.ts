import type { FinishType, RoundOutcome } from '../battle/match';
import type { AiLevel } from '../beys/motionIntent';
import { getPart, listParts, SIGNATURES, type SignatureKey } from '../beys/parts/catalog';
import type { BeyLoadout, PartKind } from '../beys/parts/types';

/**
 * 挑战模式与收集（v2.0 §8.2 / §9.1，S6）——纯逻辑，不依赖渲染与物理，可单独测试。
 *
 *  - 10 关：固定对手（签名构筑）+ AI 难度（只改决策参数）+ 竞技场 + 通关条件 + 首次通关奖励；逐关解锁（第 1 关初始开放）。
 *  - 收集：初始拥有烈刃与森衡的 6 个零件；其余 6 个零件与 2 张竞技场由挑战解锁；称号纯展示、不加属性；积分只记分（v1 无消费）。
 *  - 通关条件按“决胜回合”（拿到第 4 分的那一回合）判定：“以爆裂终结获胜” = 决胜回合是爆裂终结；
 *    “回合时长 > 20 s 获胜” = 决胜回合的判定时刻 > 20 s；“在 3 回合内获胜” = 整场（含平局重赛）不超过 3 回合。
 */

export type ArenaId = 'standard' | 'velocity' | 'sky';

export type ChallengeCondition =
  | { kind: 'none' }
  | { kind: 'finish'; finishes: FinishType[] }
  | { kind: 'longRound'; minSeconds: number; finish?: FinishType }
  | { kind: 'withinRounds'; maxRounds: number };

export type ChallengeReward = { kind: 'part'; part: PartKind; id: string } | { kind: 'arena'; id: ArenaId } | { kind: 'title'; title: string };

export interface ChallengeLevel {
  n: number;
  rival: SignatureKey;
  ai: AiLevel;
  arena: ArenaId;
  condition: ChallengeCondition;
  reward: ChallengeReward;
  /** 首次通关获得的积分（初始值；v2.0 只规定“称号 + 积分”，数值待真机体验后再定） */
  points: number;
}

export const ARENA_NAME: Record<ArenaId, string> = { standard: '标准竞技场', velocity: '极限竞技场', sky: '天空竞技场' };

/** v2.0 §8.2 挑战模式 10 关 */
export const CHALLENGES: ChallengeLevel[] = [
  { n: 1, rival: 'pandun', ai: 'rookie', arena: 'standard', condition: { kind: 'none' }, reward: { kind: 'part', part: 'blade', id: 'tidal-bastion' }, points: 100 },
  { n: 2, rival: 'senheng', ai: 'rookie', arena: 'standard', condition: { kind: 'none' }, reward: { kind: 'part', part: 'ratchet', id: 'ring-guard' }, points: 100 },
  { n: 3, rival: 'lieren', ai: 'rookie', arena: 'standard', condition: { kind: 'none' }, reward: { kind: 'part', part: 'bit', id: 'needle-point' }, points: 100 },
  { n: 4, rival: 'ziyao', ai: 'pro', arena: 'standard', condition: { kind: 'longRound', minSeconds: 20 }, reward: { kind: 'part', part: 'blade', id: 'titan-crown' }, points: 100 },
  { n: 5, rival: 'pandun', ai: 'pro', arena: 'standard', condition: { kind: 'finish', finishes: ['burst'] }, reward: { kind: 'arena', id: 'velocity' }, points: 100 },
  { n: 6, rival: 'lieren', ai: 'pro', arena: 'standard', condition: { kind: 'finish', finishes: ['over', 'xtreme'] }, reward: { kind: 'part', part: 'ratchet', id: 'tri-lock' }, points: 100 },
  { n: 7, rival: 'senheng', ai: 'pro', arena: 'standard', condition: { kind: 'longRound', minSeconds: 20, finish: 'spin' }, reward: { kind: 'part', part: 'bit', id: 'dome-ball' }, points: 100 },
  { n: 8, rival: 'ziyao', ai: 'master', arena: 'standard', condition: { kind: 'withinRounds', maxRounds: 3 }, reward: { kind: 'title', title: '持久猎手' }, points: 300 },
  { n: 9, rival: 'lieren', ai: 'master', arena: 'standard', condition: { kind: 'finish', finishes: ['burst'] }, reward: { kind: 'arena', id: 'sky' }, points: 100 },
  { n: 10, rival: 'senheng', ai: 'master', arena: 'standard', condition: { kind: 'none' }, reward: { kind: 'title', title: '竞技场之王' }, points: 500 },
];

export const FINISH_NAME: Record<FinishType, string> = { spin: '自转终结', over: '出界终结', burst: '爆裂终结', xtreme: '极限终结' };

export function conditionText(c: ChallengeCondition): string {
  switch (c.kind) {
    case 'none':
      return '以任意方式获胜';
    case 'finish':
      return `以${c.finishes.map((f) => FINISH_NAME[f]).join('或')}拿下决胜回合`;
    case 'longRound':
      return c.finish ? `以${FINISH_NAME[c.finish]}拿下决胜回合，且该回合超过 ${c.minSeconds} 秒` : `决胜回合超过 ${c.minSeconds} 秒（耐力课）`;
    case 'withinRounds':
      return `在 ${c.maxRounds} 回合内获胜（平局重赛也算回合）`;
  }
}

export function rewardText(r: ChallengeReward): string {
  switch (r.kind) {
    case 'part':
      return `${PART_KIND_NAME[r.part]}：${getPart(r.part, r.id).name}`;
    case 'arena':
      return ARENA_NAME[r.id];
    case 'title':
      return `称号“${r.title}”`;
  }
}

export const PART_KIND_NAME: Record<PartKind, string> = { blade: '刀刃', ratchet: '棘轮', bit: '轴尖' };

// ───────────────────────── 收集 ─────────────────────────

export const partKey = (kind: PartKind, id: string) => `${kind}:${id}`;

/** 初始拥有：烈刃与森衡的全部零件（v2.0 §8.2 注） */
export const STARTER_PARTS: string[] = [SIGNATURES.lieren.loadout, SIGNATURES.senheng.loadout].flatMap((l) => [partKey('blade', l.blade), partKey('ratchet', l.ratchet), partKey('bit', l.bit)]);
export const STARTER_ARENAS: ArenaId[] = ['standard'];
export const ALL_PART_KEYS: string[] = (['blade', 'ratchet', 'bit'] as PartKind[]).flatMap((k) => listParts(k).map((p) => partKey(k, p.id)));
export const ALL_ARENAS: ArenaId[] = ['standard', 'velocity', 'sky'];
/** 竞技场是否已经做出来（v1 只有标准竞技场；极限 / 天空是 v1.1，解锁后仍显示“制作中”） */
export const ARENA_PLAYABLE: Record<ArenaId, boolean> = { standard: true, velocity: false, sky: false };

/** 收集与进度（存档的一部分） */
export interface Progress {
  parts: string[];
  arenas: string[];
  cleared: number[];
  titles: string[];
  points: number;
}

export function ownsPart(p: Pick<Progress, 'parts'>, kind: PartKind, id: string): boolean {
  return p.parts.includes(partKey(kind, id));
}

export function ownsLoadout(p: Pick<Progress, 'parts'>, l: BeyLoadout): boolean {
  return ownsPart(p, 'blade', l.blade) && ownsPart(p, 'ratchet', l.ratchet) && ownsPart(p, 'bit', l.bit);
}

/** 把组装方案中没有拥有的零件逐个换成 fallback 的对应零件（fallback 必须已拥有） */
export function ownedLoadout(p: Pick<Progress, 'parts'>, l: BeyLoadout, fallback: BeyLoadout): BeyLoadout {
  return {
    blade: ownsPart(p, 'blade', l.blade) ? l.blade : fallback.blade,
    ratchet: ownsPart(p, 'ratchet', l.ratchet) ? l.ratchet : fallback.ratchet,
    bit: ownsPart(p, 'bit', l.bit) ? l.bit : fallback.bit,
  };
}

/** 哪一关解锁这个零件（初始拥有或不在奖励表里返回 null） */
export function partUnlockLevel(kind: PartKind, id: string): number | null {
  return CHALLENGES.find((c) => c.reward.kind === 'part' && c.reward.part === kind && c.reward.id === id)?.n ?? null;
}

export function arenaUnlockLevel(id: ArenaId): number | null {
  return CHALLENGES.find((c) => c.reward.kind === 'arena' && c.reward.id === id)?.n ?? null;
}

/** 第 n 关是否可以挑战：第 1 关初始开放，之后需要通关上一关 */
export function levelAvailable(p: Pick<Progress, 'cleared'>, n: number): boolean {
  return n === 1 || p.cleared.includes(n - 1);
}

/** 下一个可挑战且未通关的关卡（全部通关返回 null） */
export function nextLevel(p: Pick<Progress, 'cleared'>, after: number): number | null {
  const n = after + 1;
  return n <= CHALLENGES.length && levelAvailable(p, n) ? n : null;
}

// ───────────────────────── 判定与奖励 ─────────────────────────

export interface ChallengeMatchRecord {
  winner: 'player' | 'rival' | null;
  rounds: { outcome: RoundOutcome }[];
}

export interface ChallengeVerdict {
  won: boolean;
  conditionMet: boolean;
  cleared: boolean;
  /** 一句话说明（结算页显示） */
  detail: string;
}

export function evaluateChallenge(level: ChallengeLevel, rec: ChallengeMatchRecord): ChallengeVerdict {
  const won = rec.winner === 'player';
  const last = rec.rounds[rec.rounds.length - 1]?.outcome;
  const decisive = won && last && last.kind === 'win' && last.winner === 'player' ? last : null;
  const c = level.condition;
  let met = false;
  let detail = '';
  switch (c.kind) {
    case 'none':
      met = won;
      detail = won ? '获胜' : '未获胜';
      break;
    case 'finish':
      met = !!decisive && !!decisive.finish && c.finishes.includes(decisive.finish);
      detail = decisive ? `决胜回合：${decisive.finish ? FINISH_NAME[decisive.finish] : '—'}` : '未获胜';
      break;
    case 'longRound':
      met = !!decisive && decisive.time > c.minSeconds && (!c.finish || decisive.finish === c.finish);
      detail = decisive ? `决胜回合：${decisive.finish ? FINISH_NAME[decisive.finish] : '—'}，${decisive.time.toFixed(1)} 秒` : '未获胜';
      break;
    case 'withinRounds':
      met = won && rec.rounds.length <= c.maxRounds;
      detail = `${rec.rounds.length} 回合${won ? '获胜' : '未获胜'}`;
      break;
  }
  return { won, conditionMet: met, cleared: won && met, detail };
}

export interface ClearResult {
  progress: Progress;
  firstClear: boolean;
  /** 本次获得的奖励说明（重复通关为 null） */
  reward: string | null;
  points: number;
}

/** 通关：首次通关发放奖励与积分（幂等：重复通关不重复发放），返回新的进度（不修改传入对象） */
export function applyClear(p: Progress, level: ChallengeLevel): ClearResult {
  if (p.cleared.includes(level.n)) return { progress: p, firstClear: false, reward: null, points: 0 };
  const next: Progress = { parts: [...p.parts], arenas: [...p.arenas], cleared: [...p.cleared, level.n].sort((a, b) => a - b), titles: [...p.titles], points: p.points + level.points };
  const r = level.reward;
  if (r.kind === 'part' && !next.parts.includes(partKey(r.part, r.id))) next.parts.push(partKey(r.part, r.id));
  if (r.kind === 'arena' && !next.arenas.includes(r.id)) next.arenas.push(r.id);
  if (r.kind === 'title' && !next.titles.includes(r.title)) next.titles.push(r.title);
  return { progress: next, firstClear: true, reward: rewardText(r), points: level.points };
}

/** 签名构筑缺哪些零件（陀螺库的解锁提示） */
export function missingParts(p: Pick<Progress, 'parts'>, l: BeyLoadout): { kind: PartKind; id: string; name: string; level: number | null }[] {
  return (['blade', 'ratchet', 'bit'] as PartKind[])
    .filter((k) => !ownsPart(p, k, l[k]))
    .map((k) => ({ kind: k, id: l[k], name: getPart(k, l[k]).name, level: partUnlockLevel(k, l[k]) }));
}
