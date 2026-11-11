/// <reference types="node" />
/**
 * M5b 实验的共用部分（docs/engineering/m5b-experiment-plan.md）：签名矩阵的回合运行与记录、统计（Wilson / Newcombe / 卡方）、
 * D4 掉速口径（账本实测总掉速率 + 各来源 + 未解释残差）、整场比赛时长的重抽样估计、僵持探针（与 M2 B 部分的定义完全相同）。
 * 只读物理：这里不改任何参数；各实验臂的参数切换在调用方（with… 包装）里完成并恢复。
 */
import { ARENA, floorHeight } from '../../src/game/arena/arenaSpec';
import { EpisodeTracker } from '../../src/game/battle/burst';
import { MATCH_RULES, type FinishType } from '../../src/game/battle/match';
import type { SpinLedger } from '../../src/game/beys/BeyPhysics';
import { SIGNATURE_LIST } from '../../src/game/beys/parts/catalog';
import { rivalCommand } from '../../src/game/launcher/launch';
import { PHYSICS_DT } from '../../src/game/physics/PhysicsWorld';
import { seeded } from '../motion/motionSim';
import { setup, type R as RT, type Scn } from './stallprobe2.shared';

export type R = RT;
export const out = (tag: string, v: unknown) => process.stdout.write(`${tag} ${JSON.stringify(v)}\n`);
export const r3 = (v: number) => Math.round(v * 1000) / 1000;
export const r2 = (v: number) => Math.round(v * 100) / 100;
/** 回合间休息（秒），与 GameEngine.ROUND_REST 相同（这里不引入渲染层模块） */
export const ROUND_REST_S = 3;

// ───────────────────────────── 统计 ─────────────────────────────

export function quantile(a: number[], p: number): number {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1) + 0.5)))];
}

/** Wilson 95% 置信区间 */
export function wilson(k: number, n: number): [number, number] {
  if (!n) return [NaN, NaN];
  const z = 1.96;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(c - h) / d, (c + h) / d];
}

/** 两比例之差 p2 − p1 的 Newcombe（Wilson 混合，方法 10）95% 置信区间 */
export function newcombe(k1: number, n1: number, k2: number, n2: number): [number, number] {
  if (!n1 || !n2) return [NaN, NaN];
  const p1 = k1 / n1;
  const p2 = k2 / n2;
  const [l1, u1] = wilson(k1, n1);
  const [l2, u2] = wilson(k2, n2);
  const d = p2 - p1;
  return [d - Math.sqrt((p2 - l2) ** 2 + (u1 - p1) ** 2), d + Math.sqrt((u2 - p2) ** 2 + (p1 - l1) ** 2)];
}

/** 正则化上不完全伽马函数 Q(a, x)（Numerical Recipes：x < a+1 用级数，否则用连分式） */
function gammaQ(a: number, x: number): number {
  if (x <= 0) return 1;
  const lnGa = lnGamma(a);
  if (x < a + 1) {
    let sum = 1 / a;
    let del = sum;
    let ap = a;
    for (let n = 0; n < 500; n++) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-14) break;
    }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - lnGa);
  }
  let b = x + 1 - a;
  let c = 1 / 1e-300;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return Math.exp(-x + a * Math.log(x) - lnGa) * h;
}
function lnGamma(z: number): number {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let x = z;
  let y = z;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const c of g) ser += c / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

/** 2 × k 列联表的卡方检验（两臂 × 类别计数），返回统计量、自由度与 p 值；期望为 0 的列剔除 */
export function chiSquare2xK(a: number[], b: number[]): { chi2: number; df: number; p: number } {
  const cols = a.map((x, i) => [x, b[i]]).filter(([x, y]) => x + y > 0);
  const na = cols.reduce((s, c) => s + c[0], 0);
  const nb = cols.reduce((s, c) => s + c[1], 0);
  const n = na + nb;
  let chi2 = 0;
  for (const [x, y] of cols) {
    const t = x + y;
    const ea = (t * na) / n;
    const eb = (t * nb) / n;
    chi2 += (x - ea) ** 2 / ea + (y - eb) ** 2 / eb;
  }
  const df = Math.max(1, cols.length - 1);
  return { chi2, df, p: gammaQ(df / 2, chi2 / 2) };
}

// ───────────────────────────── 签名矩阵 ─────────────────────────────

export interface SideRec {
  key: string;
  launch: number;
  end: number;
  ledger: SpinLedger;
  won: boolean | null;
  /** 本回合最大水平速度（u/s） */
  maxSpeed: number;
}

export interface RoundRec {
  p: string;
  r: string;
  seed: number;
  kind: 'win' | 'draw' | 'none';
  finish: FinishType | null;
  own: boolean;
  winner: 'player' | 'rival' | null;
  cause: string | null;
  points: number;
  /** 判定时刻（秒）；没有判定时为模拟时长 */
  dur: number;
  sides: [SideRec, SideRec];
  /** 本回合是否出现 NaN 或在场地半径内落到地面以下 0.5 u（物理审计） */
  bad: boolean;
  /** 额外统计（实验臂可写入，例如重击次数） */
  extra?: Record<string, number>;
}

const POW = [0.65, 0.8, 0.95];

/** 签名矩阵场景：4 × 4 有序对阵 × seeds，seed = base + 1000·p + 100·r + i（与 M5a 相同的构造） */
export function matrixScenarios(base: number, seeds: number): Scn[] {
  const list: Scn[] = [];
  SIGNATURE_LIST.forEach((p, pi) =>
    SIGNATURE_LIST.forEach((r, ri) => {
      for (let i = 0; i < seeds; i++) {
        const seed = base + pi * 1000 + ri * 100 + i;
        const rnd = seeded(seed * 7 + 13);
        list.push({ name: `${p.key}-${r.key}#${i}`, group: 'SIG', player: p.loadout, rival: r.loadout, pCmd: { power: POW[i % 3], aim: (rnd() - 0.5) * 1.2, tilt: 0 }, rCmd: rivalCommand(rnd), seed, maxSeconds: MATCH_RULES.roundTimeLimit + 1, init: '签名矩阵' });
      }
    }),
  );
  return list;
}

/** 运行一个回合并记录；onStep 可读取每步状态（只读）；onSetup 在第一步之前调用（例如给 afterStep 包一层逐子步累计，只读） */
export function runRound(
  R: R,
  sc: Scn,
  onStep?: (ctx: ReturnType<typeof setup>) => void,
  onEnd?: (ctx: ReturnType<typeof setup>, rec: RoundRec) => void,
  onSetup?: (ctx: ReturnType<typeof setup>) => void,
): RoundRec {
  const orig = Math.random;
  Math.random = seeded(sc.seed);
  try {
    const ctx = setup(R, sc, { observeContacts: true });
    onSetup?.(ctx);
    const { pw, b, A, B } = ctx;
    const max = Math.round((sc.maxSeconds ?? MATCH_RULES.roundTimeLimit + 1) / PHYSICS_DT);
    const ms = [0, 0];
    let bad = false;
    let s = 0;
    for (; s < max && !b.result; s++) {
      pw.step();
      const beys = [A, B];
      for (let k = 0; k < 2; k++) {
        const bo = beys[k].body;
        const v = bo.linvel();
        const p = bo.translation();
        const h = Math.hypot(v.x, v.z);
        if (!Number.isFinite(h) || !Number.isFinite(p.y)) bad = true;
        if (h > ms[k]) ms[k] = h;
        const r = Math.hypot(p.x, p.z);
        if (r < ARENA.radius && p.y < floorHeight(r) - 0.5) bad = true;
      }
      onStep?.(ctx);
    }
    const o = b.judgeRound.outcome;
    const keyP = sc.name.split('-')[0];
    const keyR = sc.name.split('-')[1].split('#')[0];
    const won = (side: 'player' | 'rival') => (o && o.kind === 'win' ? o.winner === side : null);
    const rec: RoundRec = {
      p: keyP,
      r: keyR,
      seed: sc.seed,
      kind: o ? o.kind : 'none',
      finish: o?.finish ?? null,
      own: !!o?.own,
      winner: o?.winner ?? null,
      cause: o?.cause ?? null,
      points: o?.points ?? 0,
      dur: o?.time ?? s * PHYSICS_DT,
      sides: [
        { key: keyP, launch: A.launchSpin, end: A.spin, ledger: { ...A.ledger }, won: won('player'), maxSpeed: ms[0] },
        { key: keyR, launch: B.launchSpin, end: B.spin, ledger: { ...B.ledger }, won: won('rival'), maxSpeed: ms[1] },
      ],
      bad,
    };
    onEnd?.(ctx, rec);
    pw.dispose();
    return rec;
  } finally {
    Math.random = orig;
  }
}

const OUT = (f: FinishType | null) => f === 'over' || f === 'xtreme';

/** 一个臂的汇总：终结分布、自灭、各构筑胜率、对阵、时长、D4 掉速口径 */
export function summarize(recs: RoundRec[]) {
  const n = recs.length;
  const cnt = { spin: 0, burst: 0, over: 0, xtreme: 0, draw: 0, none: 0 };
  for (const x of recs) {
    if (x.kind === 'win') cnt[x.finish as FinishType]++;
    else if (x.kind === 'draw') cnt.draw++;
    else cnt.none++;
  }
  const own = recs.filter((x) => x.own).length;
  const perSig: Record<string, { win: number; n: number; k: number; ci: [number, number]; winsBy: Record<string, number> }> = {};
  for (const sg of SIGNATURE_LIST) {
    let k = 0;
    let m = 0;
    const by: Record<string, number> = {};
    for (const x of recs) {
      if (x.p === x.r || x.kind !== 'win') continue;
      const side = x.p === sg.key ? 'player' : x.r === sg.key ? 'rival' : null;
      if (!side) continue;
      m++;
      if (x.winner === side) {
        k++;
        by[x.finish as string] = (by[x.finish as string] ?? 0) + 1;
      }
    }
    const ci = wilson(k, m);
    perSig[sg.key] = { win: m ? r3(k / m) : NaN, n: m, k, ci: [r3(ci[0]), r3(ci[1])], winsBy: by };
  }
  const PAIRS: [string, string, string][] = [
    ['A>S', 'lieren', 'ziyao'],
    ['S>D', 'ziyao', 'pandun'],
    ['D>A', 'pandun', 'lieren'],
    ['default', 'senheng', 'pandun'],
    ['B-A', 'senheng', 'lieren'],
    ['B-S', 'senheng', 'ziyao'],
  ];
  const pairs: Record<string, string> = {};
  for (const [tag, x, y] of PAIRS) {
    let wx = 0;
    let wy = 0;
    let d = 0;
    const how: Record<string, number> = {};
    for (const q of recs) {
      if (!((q.p === x && q.r === y) || (q.p === y && q.r === x))) continue;
      if (q.kind !== 'win') {
        d++;
        continue;
      }
      const xs = q.p === x ? 'player' : 'rival';
      const w = q.winner === xs ? x : y;
      if (w === x) wx++;
      else wy++;
      const hk = `${w}:${q.finish}${q.own ? '(自灭)' : ''}`;
      how[hk] = (how[hk] ?? 0) + 1;
    }
    pairs[tag] = `${x} ${wx}:${wy} ${y}（平 ${d}）${JSON.stringify(how)}`;
  }
  const durs = recs.map((x) => x.dur);
  const atLimit = recs.filter((x) => x.dur >= MATCH_RULES.roundTimeLimit - 1e-6).length;
  return {
    rounds: n,
    counts: cnt,
    shares: Object.fromEntries(Object.entries(cnt).map(([k, v]) => [k, r3(v / n)])),
    outShare: r3((cnt.over + cnt.xtreme) / n),
    ownShare: r3(own / n),
    own,
    perSignature: perSig,
    pairs,
    durationP50: r2(quantile(durs, 0.5)),
    durationP90: r2(quantile(durs, 0.9)),
    atLimitShare: r3(atLimit / n),
    maxSpeed: r2(Math.max(...recs.flatMap((x) => x.sides.map((s) => s.maxSpeed)))),
    bad: recs.filter((x) => x.bad).length,
    spinLoss: spinLossReport(recs),
  };
}

/** 四类终结计数（卡方用）：自转 / 爆裂 / 出界 + 极限 / 平局（含无判定） */
export function finishVector(recs: RoundRec[]): number[] {
  const v = [0, 0, 0, 0];
  for (const x of recs) {
    if (x.kind !== 'win') v[3]++;
    else if (x.finish === 'spin') v[0]++;
    else if (x.finish === 'burst') v[1]++;
    else if (OUT(x.finish)) v[2]++;
  }
  return v;
}

/**
 * D4 掉速口径：每个构筑（非镜像回合的该构筑一侧）
 *   总掉速率 = Σ(发射 − 终局) / Σ回合时长；各来源每秒速率与占比；未解释残差（相对发射转速）中位 / P99 / 最大。
 *   衰减差（验收口径）：任意两构筑总掉速率之比的最大值 − 1。
 */
export function spinLossReport(recs: RoundRec[]) {
  const per: Record<string, unknown> = {};
  const rates: Record<string, number> = {};
  const resid: number[] = [];
  for (const sg of SIGNATURE_LIST) {
    const sides: { s: SideRec; dur: number }[] = [];
    for (const x of recs) {
      if (x.p === x.r) continue;
      for (const s of x.sides) if (s.key === sg.key) sides.push({ s, dur: x.dur });
    }
    const T = sides.reduce((a, v) => a + v.dur, 0) || 1;
    const net = sides.reduce((a, v) => a + (v.s.launch - v.s.end), 0);
    const src: Record<string, number> = {};
    for (const { s } of sides) for (const [k, v] of Object.entries(s.ledger)) src[k] = (src[k] ?? 0) + (v as number);
    const lossSum = Object.entries(src).reduce((a, [k, v]) => a + (k === 'contactGain' ? -v : v), 0) || 1;
    const bySource: Record<string, { perSec: number; sharePct: number }> = {};
    for (const [k, v] of Object.entries(src)) bySource[k] = { perSec: r3((k === 'contactGain' ? -v : v) / T), sharePct: r2(((k === 'contactGain' ? -v : v) / lossSum) * 100) };
    for (const { s } of sides) {
      const L = Object.entries(s.ledger).reduce((a, [k, v]) => a + (k === 'contactGain' ? -(v as number) : (v as number)), 0);
      resid.push(Math.abs(s.launch - s.end - L) / Math.max(1, s.launch));
    }
    rates[sg.key] = net / T;
    per[sg.key] = { sides: sides.length, totalPerSec: r3(net / T), launchMean: r2(sides.reduce((a, v) => a + v.s.launch, 0) / (sides.length || 1)), bySource };
  }
  const rv = Object.values(rates);
  return {
    perSignature: per,
    decayGapPct: r2((Math.max(...rv) / Math.min(...rv) - 1) * 100),
    residual: { p50: quantile(resid, 0.5), p99: quantile(resid, 0.99), max: Math.max(...resid) },
  };
}

/**
 * 整场比赛（先到 MATCH_RULES.target 分）的时长估计：每个非镜像有序对阵，从该对阵的回合里按固定种子有放回抽样，
 * 平局重赛（0 分），累计到先到目标分；时长 = Σ回合时长 + (回合数 − 1) × 回合间休息。只作参考，不作判定。
 */
export function matchEstimate(recs: RoundRec[], sims = 400, seed = 12345) {
  const rnd = seeded(seed);
  const byPair = new Map<string, RoundRec[]>();
  for (const x of recs) if (x.p !== x.r) byPair.set(`${x.p}-${x.r}`, [...(byPair.get(`${x.p}-${x.r}`) ?? []), x]);
  const rounds: number[] = [];
  const secs: number[] = [];
  for (const list of byPair.values()) {
    for (let k = 0; k < sims; k++) {
      let pa = 0;
      let pb = 0;
      let n = 0;
      let t = 0;
      while (pa < MATCH_RULES.target && pb < MATCH_RULES.target && n < 60) {
        const x = list[Math.floor(rnd() * list.length)];
        n++;
        t += x.dur;
        if (x.kind === 'win') {
          if (x.winner === 'player') pa += x.points;
          else pb += x.points;
        }
      }
      rounds.push(n);
      secs.push(t + (n - 1) * ROUND_REST_S);
    }
  }
  return { roundsMean: r2(rounds.reduce((a, v) => a + v, 0) / rounds.length), roundsP90: quantile(rounds, 0.9), secondsMean: r2(secs.reduce((a, v) => a + v, 0) / secs.length), secondsP90: r2(quantile(secs, 0.9)) };
}

// ───────────────────────────── 僵持探针（定义与 M2 B 部分相同） ─────────────────────────────

export interface ProbeOut {
  name: string;
  steps: number;
  finish: string | null;
  /** 无接触低速段（双方水平速度 < 0.2 u/s 且无确认接触）最长秒数 */
  longestIdle: number;
  /** 接触段结束后 2 s 内重接触：可判定次数 / 命中次数 */
  recontactN: number;
  recontactHit: number;
  episodes: number;
}

export function probe(R: R, sc: Scn, maxSeconds: number): ProbeOut {
  const orig = Math.random;
  Math.random = seeded(sc.seed);
  try {
    const { pw, b, A, B } = setup(R, sc, { observeContacts: true });
    const cs = pw.contacts!;
    const ep = new EpisodeTracker(PHYSICS_DT);
    const ends: number[] = [];
    const starts: number[] = [];
    let idle = 0;
    let longest = 0;
    const max = Math.round(maxSeconds / PHYSICS_DT);
    let s = 0;
    for (; s < max && !b.result; s++) {
      pw.step();
      const imp = cs.bodyPair('player', 'rival')?.normalImpulse ?? 0;
      const before = ep.count;
      const closed = ep.step(s, imp);
      if (closed) ends.push(closed.lastStep);
      if (ep.count > before) starts.push(s);
      const va = A.body.linvel();
      const vb = B.body.linvel();
      if (Math.hypot(va.x, va.z) < 0.2 && Math.hypot(vb.x, vb.z) < 0.2 && imp <= 0) {
        idle += PHYSICS_DT;
        if (idle > longest) longest = idle;
      } else idle = 0;
    }
    const fin = ep.flush();
    if (fin) ends.push(fin.lastStep);
    let n = 0;
    let hit = 0;
    const win = Math.round(2 / PHYSICS_DT);
    for (const e of ends) {
      if (e + win >= s) continue; // 回合在 2 s 内结束：不可判定
      n++;
      if (starts.some((t) => t > e && t <= e + win)) hit++;
    }
    const o: ProbeOut = { name: sc.name, steps: s, finish: b.result ? `${b.result.winner ?? 'draw'}:${b.result.finish ?? b.result.cause}` : 'none', longestIdle: r3(longest), recontactN: n, recontactHit: hit, episodes: ep.count };
    pw.dispose();
    return o;
  } finally {
    Math.random = orig;
  }
}

/** 镜像探针场景：同一构筑对同一构筑，seed = base + i，回合上限 maxSeconds */
export function mirrorProbes(key: string, base: number, n: number, maxSeconds: number): Scn[] {
  const sig = SIGNATURE_LIST.find((s) => s.key === key)!.loadout;
  const list: Scn[] = [];
  for (let i = 0; i < n; i++) {
    const rnd = seeded(base + i);
    list.push({ name: `${key}-${key}#${i}`, group: 'MIRROR', player: sig, rival: sig, pCmd: { power: POW[i % 3], aim: (rnd() - 0.5) * 1.2, tilt: 0 }, rCmd: rivalCommand(rnd), seed: base + i, maxSeconds, init: `${key} 镜像` });
  }
  return list;
}

export function probePool(rs: ProbeOut[]) {
  const n = rs.reduce((a, r) => a + r.recontactN, 0);
  const h = rs.reduce((a, r) => a + r.recontactHit, 0);
  const idles = rs.map((r) => r.longestIdle);
  const ci = wilson(h, n);
  return {
    rounds: rs.length,
    recontact: { n, hit: h, rate: n ? r3(h / n) : NaN, ci: [r3(ci[0]), r3(ci[1])] },
    longestIdleP50: r2(quantile(idles, 0.5)),
    longestIdleMax: r2(Math.max(...idles)),
    idleOver5: rs.filter((r) => r.longestIdle >= 5).length,
    durationMean: r2(rs.reduce((a, r) => a + r.steps, 0) / rs.length / 120),
  };
}

/** 临时修改竞技场参数并在结束后恢复 */
export function withArena<T>(o: Partial<{ centerFlat: number; edge: number; bowl: number }>, fn: () => T): T {
  const old = { centerFlat: ARENA.centerFlat, edge: ARENA.edge, bowl: ARENA.bowl };
  Object.assign(ARENA, o);
  try {
    return fn();
  } finally {
    Object.assign(ARENA, old);
  }
}

/** 临时修改回合规则并在结束后恢复 */
export function withRules<T>(patch: Partial<typeof MATCH_RULES>, fn: () => T): T {
  const old = { ...MATCH_RULES };
  Object.assign(MATCH_RULES, patch);
  try {
    return fn();
  } finally {
    Object.assign(MATCH_RULES, old);
  }
}
