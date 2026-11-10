/**
 * 碰撞 / 交锋诊断工具（无头，只跑物理，不渲染）。
 *
 * 每个“碰撞事件”= 两台陀螺从开始接触到分开的整个过程（可能持续多个物理步）。
 * 对每个事件记录：
 *  - 碰撞前（物理步之前）的线速度、转速、位置、质量；
 *  - Rapier 求解器在每一步给出的法向 / 切向接触冲量（world.contactPair）；
 *  - Rapier 求解后、游戏逻辑（撞击结算）之后的速度 → 拆分出“引擎冲量”和“游戏额外冲量”；
 *  - 事件结束时的速度、转速、有效恢复系数 e = -v_rel'·n / v_rel·n。
 * 同时统计：撞击结算在同一事件里被触发几次（检查重复施加）、外圈绕行时间、交锋间隔。
 */
import { createArenaPhysics } from '../../src/game/arena/ArenaPhysics';
import { ARENA } from '../../src/game/arena/arenaSpec';
import { BattleSystem } from '../../src/game/battle/BattleSystem';
import type { BeyPhysics } from '../../src/game/beys/BeyPhysics';
import { assembleBey } from '../../src/game/beys/parts/assemble';
import type { BeyLoadout } from '../../src/game/beys/parts/types';
import type { LaunchCommand } from '../../src/game/launcher/PullStringGesture';
import { loadRapier, PhysicsWorld, PHYSICS_DT } from '../../src/game/physics/PhysicsWorld';
import { defaultSeed, withDeterminism } from '../repro/determinism';

export interface Episode {
  t: number;
  steps: number;
  /** 撞击结算被触发的次数（>1 说明同一次碰撞被重复施加） */
  smashCalls: number;
  ma: number;
  mb: number;
  /** 碰撞前法向接近速度 m/s */
  approach: number;
  /** 碰撞前切向相对速度 m/s */
  tangential: number;
  speedA0: number;
  speedB0: number;
  spinA0: number;
  spinB0: number;
  /** Rapier 求解器给出的法向冲量总和（N·s） */
  rapierNormal: number;
  rapierTangent: number;
  /** 游戏逻辑额外施加的冲量（由速度变化反推，N·s） */
  extraA: number;
  extraB: number;
  /** 事件前后速度变化量 m/s */
  dvA: number;
  dvB: number;
  /** 方向变化角度（度） */
  turnA: number;
  turnB: number;
  dSpinA: number;
  dSpinB: number;
  /** 有效恢复系数（>1 表示碰撞后反而“弹”得比撞进来还快） */
  restitution: number;
  /** 游戏判定的力度 / 等级 */
  strength: number;
  tier: string;
}

export interface DiagResult {
  episodes: Episode[];
  duration: number;
  hits: number;
  result: string;
  /** 外圈（r > 3.3）停留时间占比 */
  outerFraction: { player: number; rival: number };
  /** 交锋间隔（秒） */
  gaps: number[];
  /** 平均水平速度 */
  meanSpeed: { player: number; rival: number };
  /** 撞墙次数（刀刃 / 盘碰到外墙的接触事件）与撞墙时的径向速度 */
  wallHits: { player: number; rival: number };
  wallHitSpeeds: number[];
  /** 贴边时间占比（外沿距墙 < 0.25） */
  nearWall: { player: number; rival: number };
  /** 平均离中心距离 */
  meanR: { player: number; rival: number };
  /** 转速降到发射时一半所用的时间（秒，未降到则为对局时长） */
  spinHalf: { player: number; rival: number };
  /** 每次中等以上撞击中各自受到的速度变化 */
  dvTaken: { player: number[]; rival: number[] };
  /** 获胜方 */
  winner: 'player' | 'rival' | 'none';
}

const h = (v: { x: number; z: number }) => Math.hypot(v.x, v.z);
const angle = (a: { x: number; z: number }, b: { x: number; z: number }) => {
  const la = h(a);
  const lb = h(b);
  if (la < 0.2 || lb < 0.2) return 0;
  const c = (a.x * b.x + a.z * b.z) / (la * lb);
  return (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
};

export async function diagnoseBattle(opts: {
  player: LaunchCommand;
  rival: LaunchCommand;
  playerLoadout?: BeyLoadout;
  rivalLoadout?: BeyLoadout;
  maxSeconds?: number;
  /** 随机种子；省略时由参数派生（见 tests/repro/determinism.ts defaultSeed） */
  seed?: number | null;
}): Promise<DiagResult> {
  const R = await loadRapier();
  const { PLAYER_LOADOUT, RIVAL_LOADOUT } = await import('../../src/game/beys/parts/catalog');
  const pw = new PhysicsWorld(R);
  const arena = createArenaPhysics(pw);
  const wallSet = new Set(arena.walls.map((c) => c.handle));
  const battle = new BattleSystem(pw, {
    player: assembleBey(opts.playerLoadout ?? PLAYER_LOADOUT),
    rival: assembleBey(opts.rivalLoadout ?? RIVAL_LOADOUT),
  });
  const launch = () => {
    battle.launch('player', opts.player);
    battle.launch('rival', opts.rival);
  };
  // seed: null = 沿用调用方当前的全局 Math.random（旧诊断脚本自行替换 Math.random 时使用）
  if (opts.seed === null) launch();
  else withDeterminism(opts.seed ?? defaultSeed(opts), launch);
  const A = battle.beys.player!;
  const B = battle.beys.rival!;

  const snap = (b: BeyPhysics) => {
    const v = b.body.linvel();
    const p = b.body.translation();
    return { v: { x: v.x, y: v.y, z: v.z }, p: { x: p.x, y: p.y, z: p.z }, spin: b.spin };
  };
  const contactImpulse = () => {
    let n = 0;
    let t = 0;
    let touching = false;
    for (const ca of A.colliders) {
      for (const cb of B.colliders) {
        pw.world.contactPair(ca, cb, (m) => {
          for (let i = 0; i < m.numContacts(); i++) {
            if (m.contactDist(i) < 0.02) touching = true;
            n += m.contactImpulse(i);
            t += Math.hypot(m.contactTangentImpulseX(i), m.contactTangentImpulseY(i));
          }
        });
      }
    }
    return { n, t, touching };
  };

  const episodes: Episode[] = [];
  let cur: (Episode & { _a0: ReturnType<typeof snap>; _b0: ReturnType<typeof snap>; _n: { x: number; z: number }; _gap: number }) | null = null;
  let preA = snap(A);
  let preB = snap(B);
  let apart = 0;
  let lastEnd = 0;
  const gaps: number[] = [];
  const outer = { player: 0, rival: 0 };
  const wallHits = { player: 0, rival: 0 };
  const wallHitSpeeds: number[] = [];
  const onWall = { player: false, rival: false };
  const nearWall = { player: 0, rival: 0 };
  const rSum = { player: 0, rival: 0 };
  const spin0 = { player: A.spin, rival: B.spin };
  const spinHalf = { player: -1, rival: -1 };
  const dvTaken = { player: [] as number[], rival: [] as number[] };
  const speedSum = { player: 0, rival: 0 };
  let steps = 0;

  pw.beforeStep = (dt) => {
    battle.preStep(dt);
    preA = snap(A);
    preB = snap(B);
  };
  pw.afterStep = (dt) => {
    const postA = snap(A);
    const postB = snap(B);
    const imp = contactImpulse();
    const hitsBefore = battle.hits;
    const impactsBefore = battle.impacts.length;
    battle.postStep(dt);
    const finA = snap(A);
    const finB = snap(B);

    if (imp.touching || imp.n > 0) {
      apart = 0;
      if (!cur) {
        let nx = preB.p.x - preA.p.x;
        let nz = preB.p.z - preA.p.z;
        const l = Math.hypot(nx, nz) || 1;
        nx /= l;
        nz /= l;
        const rvx = preA.v.x - preB.v.x;
        const rvz = preA.v.z - preB.v.z;
        cur = {
          t: battle.time,
          steps: 0,
          smashCalls: 0,
          ma: A.body.mass(),
          mb: B.body.mass(),
          approach: rvx * nx + rvz * nz,
          tangential: Math.abs(-rvx * nz + rvz * nx),
          speedA0: h(preA.v),
          speedB0: h(preB.v),
          spinA0: preA.spin,
          spinB0: preB.spin,
          rapierNormal: 0,
          rapierTangent: 0,
          extraA: 0,
          extraB: 0,
          dvA: 0,
          dvB: 0,
          turnA: 0,
          turnB: 0,
          dSpinA: 0,
          dSpinB: 0,
          restitution: 0,
          strength: 0,
          tier: '',
          _a0: preA,
          _b0: preB,
          _n: { x: nx, z: nz },
          _gap: battle.time - lastEnd,
        };
      }
      cur.steps++;
      cur.rapierNormal += imp.n;
      cur.rapierTangent += imp.t;
      cur.extraA += cur.ma * Math.hypot(finA.v.x - postA.v.x, finA.v.z - postA.v.z);
      cur.extraB += cur.mb * Math.hypot(finB.v.x - postB.v.x, finB.v.z - postB.v.z);
      cur.smashCalls += battle.hits - hitsBefore;
      if (battle.impacts.length > impactsBefore) {
        const e = battle.impacts[battle.impacts.length - 1];
        cur.strength = Math.max(cur.strength, e.strength);
        cur.tier = e.tier;
      }
    } else if (cur) {
      apart++;
      if (apart >= 3) {
        const n = cur._n;
        const relBefore = (cur._a0.v.x - cur._b0.v.x) * n.x + (cur._a0.v.z - cur._b0.v.z) * n.z;
        const relAfter = (finA.v.x - finB.v.x) * n.x + (finA.v.z - finB.v.z) * n.z;
        cur.restitution = relBefore > 0.05 ? -relAfter / relBefore : NaN;
        cur.dvA = Math.hypot(finA.v.x - cur._a0.v.x, finA.v.z - cur._a0.v.z);
        cur.dvB = Math.hypot(finB.v.x - cur._b0.v.x, finB.v.z - cur._b0.v.z);
        cur.turnA = angle(cur._a0.v, finA.v);
        cur.turnB = angle(cur._b0.v, finB.v);
        cur.dSpinA = finA.spin - cur._a0.spin;
        cur.dSpinB = finB.spin - cur._b0.spin;
        if (episodes.length > 0) gaps.push(cur._gap);
        const { _a0, _b0, _n, _gap, ...ep } = cur;
        void _a0;
        void _b0;
        void _n;
        void _gap;
        episodes.push(ep);
        if (ep.tier === 'medium' || ep.tier === 'heavy') {
          dvTaken.player.push(ep.dvA);
          dvTaken.rival.push(ep.dvB);
        }
        lastEnd = battle.time;
        cur = null;
      }
    }
    steps++;
    for (const [side, b] of [['player', A], ['rival', B]] as const) {
      const p = b.body.translation();
      const r = Math.hypot(p.x, p.z);
      if (r > ARENA.railInner - 0.7) outer[side] += dt;
      if (r + b.spec.outerRadius > ARENA.radius - 0.25 && r < ARENA.radius) nearWall[side] += dt;
      rSum[side] += r;
      speedSum[side] += h(b.body.linvel());
      if (spinHalf[side] < 0 && b.spin < spin0[side] * 0.5) spinHalf[side] = battle.time;
      let touching = false;
      for (const c of b.colliders) {
        pw.world.contactPairsWith(c, (o) => {
          if (wallSet.has(o.handle)) touching = true;
        });
      }
      if (touching && !onWall[side]) {
        wallHits[side]++;
        const v = b.body.linvel();
        wallHitSpeeds.push(r > 0.01 ? (v.x * p.x + v.z * p.z) / r : 0);
      }
      onWall[side] = touching;
    }
  };

  const max = (opts.maxSeconds ?? 60) / PHYSICS_DT;
  for (let i = 0; i < max && !battle.result; i++) pw.step();
  const duration = battle.time;
  const out: DiagResult = {
    episodes,
    duration,
    hits: battle.hits,
    result: battle.result ? `${battle.result.loser} ${battle.result.finish}` : 'timeout',
    outerFraction: { player: outer.player / duration, rival: outer.rival / duration },
    gaps,
    meanSpeed: { player: speedSum.player / steps, rival: speedSum.rival / steps },
    wallHits,
    wallHitSpeeds,
    nearWall: { player: nearWall.player / duration, rival: nearWall.rival / duration },
    meanR: { player: rSum.player / steps, rival: rSum.rival / steps },
    spinHalf: { player: spinHalf.player < 0 ? duration : spinHalf.player, rival: spinHalf.rival < 0 ? duration : spinHalf.rival },
    dvTaken,
    winner: battle.result?.winner ?? 'none',
  };
  pw.dispose();
  return out;
}

const med = (a: number[]) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

/** 把多场诊断汇总成表格（Markdown） */
export function summarize(label: string, runs: DiagResult[]): string {
  const eps = runs.flatMap((r) => r.episodes);
  const dur = runs.reduce((s, r) => s + r.duration, 0);
  const byTier = (t: string) => eps.filter((e) => e.tier === t);
  const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '-');
  const lines = [
    `### ${label}`,
    '',
    `- 对战 ${runs.length} 场，总时长 ${dur.toFixed(0)} 秒，接触事件 ${eps.length} 次；**有效撞击 ${eps.filter((e) => e.tier).length} 次 = ${f((eps.filter((e) => e.tier).length / dur) * 10, 2)} 次 / 10 秒**（其余为贴身摩擦）`,
    `- **发射撞击之后**的中等以上撞击：${eps.filter((e) => e.t > 1.5 && (e.tier === 'medium' || e.tier === 'heavy')).length} 次 = ${f((eps.filter((e) => e.t > 1.5 && (e.tier === 'medium' || e.tier === 'heavy')).length / dur) * 10, 2)} 次 / 10 秒`,
    `- 交锋间隔中位数 ${f(med(runs.flatMap((r) => r.gaps)), 1)} 秒，最长 ${f(Math.max(0, ...runs.flatMap((r) => r.gaps)), 1)} 秒；平均速度 player ${f(runs.reduce((s, r) => s + r.meanSpeed.player, 0) / runs.length)} / rival ${f(runs.reduce((s, r) => s + r.meanSpeed.rival, 0) / runs.length)} m/s；平均时长 ${f(dur / runs.length, 1)} 秒`,
    `- 外圈停留占比：player ${f((runs.reduce((s, r) => s + r.outerFraction.player, 0) / runs.length) * 100, 0)}%，rival ${f((runs.reduce((s, r) => s + r.outerFraction.rival, 0) / runs.length) * 100, 0)}%`,
    `- 撞墙：${f((runs.reduce((s, r) => s + r.wallHits.player + r.wallHits.rival, 0) / dur) * 10, 2)} 次 / 10 秒（两台合计），撞墙径向速度中位数 ${f(med(runs.flatMap((r) => r.wallHitSpeeds)))} m/s；贴边时间 player ${f((runs.reduce((s, r) => s + r.nearWall.player, 0) / runs.length) * 100, 0)}% / rival ${f((runs.reduce((s, r) => s + r.nearWall.rival, 0) / runs.length) * 100, 0)}%`,
    `- 一次碰撞里撞击结算被触发多次（重复施加）：${eps.filter((e) => e.smashCalls > 1).length} 次`,
    `- 结果：${runs.map((r) => r.result).join('，')}`,
    '',
    '| 等级 | 次数 | 接近速度 | Rapier 法向冲量 | 额外冲量 A/B | 有效恢复系数 e | Δv A/B | 转向角 A/B | 转速变化 A/B |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  for (const t of ['light', 'medium', 'heavy']) {
    const g = byTier(t);
    if (!g.length) {
      lines.push(`| ${t} | 0 | | | | | | | |`);
      continue;
    }
    lines.push(
      `| ${t} | ${g.length} | ${f(med(g.map((e) => e.approach)))} | ${f(med(g.map((e) => e.rapierNormal)))} | ${f(med(g.map((e) => e.extraA)))} / ${f(med(g.map((e) => e.extraB)))} | ${f(med(g.map((e) => e.restitution).filter(Number.isFinite)))} | ${f(med(g.map((e) => e.dvA)))} / ${f(med(g.map((e) => e.dvB)))} | ${f(med(g.map((e) => e.turnA)), 0)}° / ${f(med(g.map((e) => e.turnB)), 0)}° | ${f(med(g.map((e) => e.dSpinA)), 1)} / ${f(med(g.map((e) => e.dSpinB)), 1)} |`,
    );
  }
  return lines.join('\n');
}
