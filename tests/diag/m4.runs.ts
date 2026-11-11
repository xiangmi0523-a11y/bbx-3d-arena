/// <reference types="node" />
/**
 * M4 实验的共用运行器（M4-A 基准与 M4-B/C/D 各实验臂同一套场景、种子与口径）：
 *  - soloRun / soloSuite：单台在场地里转到停（无对手、无战术意图）；
 *  - runSet：一组对局（逐步记录 → analyzeRound → 按构筑累计曲线），附带典型结尾样本。
 * 只读物理（见 m4.metrics.ts）；实验臂的开关切换在调用方完成并恢复。
 */
import type RAPIER from '@dimforge/rapier3d-compat';
import { ARENA } from '../../src/game/arena/arenaSpec';
import { createArenaPhysics, TABLE_Y } from '../../src/game/arena/ArenaPhysics';
import { FINISH_TUNING } from '../../src/game/battle/BattleSystem';
import { BeyPhysics } from '../../src/game/beys/BeyPhysics';
import { assembleBey } from '../../src/game/beys/parts/assemble';
import { BITS, SIGNATURE_LIST } from '../../src/game/beys/parts/catalog';
import type { BeyLoadout } from '../../src/game/beys/parts/types';
import { computeLaunch } from '../../src/game/launcher/launch';
import { loadRapier, PhysicsWorld, PHYSICS_DT } from '../../src/game/physics/PhysicsWorld';
import { seeded } from '../motion/motionSim';
import { addCurves, analyzeRound, baseTilt, C, curveReport, curveShape, findFloor, FL, freeMask, median, newCurve, r2, r3, steps, Trace, type CurveAcc, type FinishInfo, type RoundMetrics } from './m4.metrics';
import { runRound, type RoundRec } from './m5b.shared';
import type { Scn } from './stallprobe2.shared';

export type R = Awaited<ReturnType<typeof loadRapier>>;
const DT = PHYSICS_DT;
export const POW = [0.65, 0.8, 0.95];

// ───────────────────────────── SOLO ─────────────────────────────

export interface SoloRec {
  name: string;
  power: number;
  seed: number;
  end: string;
  endAt: number;
  launch: number;
  since05: number | null;
  since03: number | null;
  since01: number | null;
  /** 最后 3 s：超出倾角最大值、平均速度 / 转速比例 0.5–0.6 段平均速度、首次触地距结束、末段倾角 Spearman 方向 */
  last3MaxExcess: number;
  last3SpeedOverMid: number | null;
  firstFloorBeforeEnd: number | null;
  floorSec: number;
  baseTilt: number;
  /** 超出倾角首次持续 ≥ 0.25 rad（之后不再回落 0.2 s 以上）到结束的秒数 */
  destabDuration: number | null;
  destabOnsetRatio: number | null;
}

export function soloRun(R: R, name: string, loadout: BeyLoadout, power: number, seed: number, acc: CurveAcc, maxSeconds = 150): SoloRec {
  const rnd0 = Math.random;
  Math.random = seeded(seed);
  try {
    const pw = new PhysicsWorld(R, { observeContacts: true });
    createArenaPhysics(pw);
    const floor = findFloor(R, pw.world);
    const spec = assembleBey(loadout);
    const rnd = seeded(seed * 7 + 13);
    const params = computeLaunch(spec, 'player', { power, aim: (rnd() - 0.5) * 0.8, tilt: 0 });
    const bey = new BeyPhysics(pw, spec, { ...params, seed });
    pw.beforeStep = (dt) => bey.preStep(dt);
    const tr = new Trace(1, maxSeconds + 1);
    let end = 'limit';
    let endStep = -1;
    let held = 0;
    const max = steps(maxSeconds);
    for (let s = 0; s < max; s++) {
      pw.step();
      tr.record(pw.world, [bey], floor, 0, false);
      const p = bey.body.translation();
      const r = Math.hypot(p.x, p.z);
      const isOut = r > ARENA.radius + FINISH_TUNING.outMargin || p.y < TABLE_Y + 0.5;
      const toppled = bey.tilt > FINISH_TUNING.toppleTilt && bey.spin < FINISH_TUNING.toppleSpin;
      const stopped = bey.spin < FINISH_TUNING.stopSpin;
      if (isOut || toppled || stopped) {
        if (endStep < 0) {
          endStep = s;
          end = isOut ? 'out' : toppled ? 'topple' : 'stop';
        }
        held += DT;
        if (held > 0.5) break;
      } else {
        held = 0;
        endStep = -1;
      }
    }
    const free = freeMask(tr);
    addCurves(tr, 0, acc, free);
    const i0 = endStep >= 0 ? endStep : tr.n - 1;
    const base = baseTilt(tr, 0, free);
    const since = (thr: number) => {
      for (let i = 0; i <= i0; i++) if (tr.v(0, i, C.ratio) < thr) return r2((i0 - i) * DT);
      return null;
    };
    let maxEx = 0;
    const sp3: number[] = [];
    for (let i = Math.max(0, i0 - steps(3)); i <= i0; i++) {
      maxEx = Math.max(maxEx, tr.v(0, i, C.tiltN) - base);
      sp3.push(Math.hypot(tr.v(0, i, C.vx), tr.v(0, i, C.vz)));
    }
    const spMid: number[] = [];
    for (let i = 0; i <= i0; i++) {
      const rt = tr.v(0, i, C.ratio);
      if (rt >= 0.5 && rt < 0.6) spMid.push(Math.hypot(tr.v(0, i, C.vx), tr.v(0, i, C.vz)));
    }
    let firstFloor: number | null = null;
    for (let i = Math.max(0, i0 - steps(3)); i <= i0; i++)
      if (tr.has(0, i, FL.floor)) {
        firstFloor = r2((i0 - i) * DT);
        break;
      }
    let floorN = 0;
    for (let i = 0; i < tr.n; i++) if (tr.has(0, i, FL.floor)) floorN++;
    // 失衡过程（与终结过程同一定义）
    let destab: number | null = null;
    let onsetRatio: number | null = null;
    if (tr.v(0, i0, C.tiltN) - base >= 0.25) {
      let below = 0;
      let tStar = 0;
      for (let i = i0; i >= 0; i--) {
        if (tr.v(0, i, C.tiltN) - base < 0.25) {
          below++;
          if (below > steps(0.2)) {
            tStar = i + below;
            break;
          }
        } else below = 0;
      }
      destab = r2((i0 - tStar) * DT);
      onsetRatio = r3(tr.v(0, tStar, C.ratio));
    }
    pw.dispose();
    const m3 = sp3.reduce((a, v) => a + v, 0) / Math.max(1, sp3.length);
    const mm = spMid.length ? spMid.reduce((a, v) => a + v, 0) / spMid.length : NaN;
    return {
      name,
      power,
      seed,
      end,
      endAt: r2((i0 + 1) * DT),
      launch: r2(params.spin),
      since05: since(0.5),
      since03: since(0.3),
      since01: since(0.1),
      last3MaxExcess: r3(maxEx),
      last3SpeedOverMid: Number.isFinite(mm) && mm > 1e-3 ? r3(m3 / mm) : null,
      firstFloorBeforeEnd: firstFloor,
      floorSec: r2(floorN * DT),
      baseTilt: r3(base),
      destabDuration: destab,
      destabOnsetRatio: onsetRatio,
    };
  } finally {
    Math.random = rnd0;
  }
}

// ───────────────────────────── 对局（矩阵 / 轴心变体） ─────────────────────────────

export interface Example {
  name: string;
  finish: string | null;
  loser: string | null;
  /** 发起前 6 s，每 0.1 s：[距发起秒数, 输方转速比例, 输方超出倾角, 输方速度, 赢方超出倾角, 赢方速度, 接触(0/1), 输方触地(0/1)] */
  series: number[][];
}

export function runSet(R: R, scs: Scn[], tag: string, examples?: Example[]) {
  const curves: Record<string, CurveAcc> = {};
  const metrics: RoundMetrics[] = [];
  const extras: Record<string, number>[] = [];
  const t0 = Date.now();
  const recs: RoundRec[] = scs.map((sc) => {
    let tr: Trace | null = null;
    let floor: RAPIER.Collider | null = null;
    let seen = 0;
    return runRound(
      R,
      sc,
      (ctx) => {
        if (!tr) {
          tr = new Trace(2, (sc.maxSeconds ?? 61) + 1);
          floor = findFloor(R, ctx.pw.world);
        }
        const bp = ctx.pw.contacts?.bodyPair('player', 'rival');
        const hit = ctx.b.impacts.length > seen;
        seen = ctx.b.impacts.length;
        tr.record(ctx.pw.world, [ctx.A, ctx.B], floor!, bp?.normalImpulse ?? 0, hit);
      },
      (ctx, rec) => {
        const o = ctx.b.judgeRound.outcome;
        const side = (s: string | null | undefined) => (s === 'player' ? 0 : s === 'rival' ? 1 : null);
        const fin: FinishInfo = { kind: o ? o.kind : 'none', finish: o?.finish ?? null, cause: o?.cause ?? null, winner: side(o?.winner), loser: side(o?.loser), initiatedAt: o?.initiatedAt ?? rec.dur };
        const t = tr!;
        const m = analyzeRound(t, [rec.p, rec.r], fin);
        metrics.push(m);
        const free = freeMask(t);
        addCurves(t, 0, (curves[rec.p] ??= newCurve()), free);
        addCurves(t, 1, (curves[rec.r] ??= newCurve()), free);
        const ex = { wobbleBreaks: ctx.b.wobbleBreaks, breakouts: ctx.b.breakouts, hits: ctx.b.hits, grinds: ctx.b.grinds, knockResyncs: ctx.A.knockResyncs + ctx.B.knockResyncs };
        rec.extra = ex;
        extras.push(ex);
        if (examples && fin.kind === 'win' && fin.cause === 'finish' && fin.loser !== null && fin.winner !== null && examples.filter((e) => e.finish === fin.finish).length < 2) {
          const L = fin.loser;
          const W = fin.winner;
          const bl = baseTilt(t, L, free);
          const bw = baseTilt(t, W, free);
          const i0 = Math.min(t.n - 1, Math.round(fin.initiatedAt / DT));
          const series: number[][] = [];
          for (let i = Math.max(0, i0 - steps(6)); i <= i0; i += steps(0.1))
            series.push([r2((i - i0) * DT), r3(t.v(L, i, C.ratio)), r3(t.v(L, i, C.tiltN) - bl), r2(t.speed(L, i)), r3(t.v(W, i, C.tiltN) - bw), r2(t.speed(W, i)), t.imp[i] > 0 ? 1 : 0, t.has(L, i, FL.floor) ? 1 : 0]);
          examples.push({ name: sc.name, finish: fin.finish, loser: fin.loser === 0 ? rec.p : rec.r, series });
        }
      },
    );
  });
  const curveOut: Record<string, unknown> = {};
  for (const [k, acc] of Object.entries(curves)) curveOut[k] = { shape: curveShape(acc), bins: curveReport(acc) };
  const wb = extras.map((e) => e.wobbleBreaks);
  return {
    recs,
    metrics,
    ms: Date.now() - t0,
    curves: curveOut,
    tactics: {
      wobbleBreakRounds: wb.filter((v) => v > 0).length,
      wobbleBreaksPerRound: r3(wb.reduce((a, v) => a + v, 0) / Math.max(1, wb.length)),
      hitsPerRound: r2(extras.reduce((a, e) => a + e.hits, 0) / Math.max(1, extras.length)),
      grindsPerRound: r2(extras.reduce((a, e) => a + e.grinds, 0) / Math.max(1, extras.length)),
      tag,
    },
  };
}

/** M5b 记录的 base 臂终结计数（20000 × 20，m5b-results.md / CI 42926606096） */
export const M5B_BASE_COUNTS = { spin: 246, burst: 65, over: 2, xtreme: 0, draw: 7, none: 0 };

export const PAIRS: [string, string, string][] = [
  ['A>S', 'lieren', 'ziyao'],
  ['S>D', 'ziyao', 'pandun'],
  ['D>A', 'pandun', 'lieren'],
  ['default', 'senheng', 'pandun'],
  ['B-A', 'senheng', 'lieren'],
  ['B-S', 'senheng', 'ziyao'],
];

/** M4 单台套件：四个签名构筑 × 三种力度 × 2 种子（seed 90000+…）+ 疾风新月 / 六齿棘轮配四种轴心 × 力度 0.8 × 3（seed 91000+…） */
export function soloSuite(R: R) {
  const t0 = Date.now();
  const recs: SoloRec[] = [];
  const curves: Record<string, CurveAcc> = {};
  SIGNATURE_LIST.forEach((sg, si) => {
    POW.forEach((p, pi) => {
      for (let i = 0; i < 2; i++) recs.push(soloRun(R, sg.key, sg.loadout, p, 90000 + si * 100 + pi * 10 + i, (curves[sg.key] ??= newCurve())));
    });
  });
  Object.keys(BITS).forEach((bit, bi) => {
    for (let i = 0; i < 3; i++) recs.push(soloRun(R, `衡+${bit}`, { blade: 'gale-crescent', ratchet: 'hex-lock', bit }, 0.8, 91000 + bi * 10 + i, (curves[`衡+${bit}`] ??= newCurve())));
  });
  const byName: Record<string, Record<string, unknown>> = {};
  for (const name of [...new Set(recs.map((x) => x.name))]) {
    const g = recs.filter((x) => x.name === name);
    const nums = (f: (x: SoloRec) => number | null) => g.map(f).filter((v): v is number => typeof v === 'number');
    byName[name] = {
      runs: g.length,
      ends: g.reduce<Record<string, number>>((a, x) => ((a[x.end] = (a[x.end] ?? 0) + 1), a), {}),
      endAtP50: r2(median(nums((x) => x.endAt))),
      since03P50: r2(median(nums((x) => x.since03))),
      since01P50: r2(median(nums((x) => x.since01))),
      destabShare: r3(g.filter((x) => x.destabDuration !== null).length / g.length),
      destabDurationP50: r2(median(nums((x) => x.destabDuration))),
      destabOnsetRatioP50: r3(median(nums((x) => x.destabOnsetRatio))),
      last3MaxExcessP50: r3(median(nums((x) => x.last3MaxExcess))),
      last3SpeedOverMidP50: r3(median(nums((x) => x.last3SpeedOverMid))),
      floorInLast3sShare: r3(g.filter((x) => x.firstFloorBeforeEnd !== null).length / g.length),
      shape: curveShape(curves[name]),
      bins: curveReport(curves[name]),
    };
  }
  return { recs, byName, curves, ms: Date.now() - t0 };
}
