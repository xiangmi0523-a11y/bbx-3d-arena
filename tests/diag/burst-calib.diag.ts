/// <reference types="node" />
/**
 * 爆裂标定诊断（产品总方案 v2.0 §6.3 的标定方法；只读，不改物理、AI、接触与规则）。
 *
 *  (a) 固定种子场景，开启只读 ContactService，统计两台陀螺之间每个接触段的实测法向冲量之和 Σ（N·s）分布；
 *      同时把 resolveSmash 的撞击事件（轻 / 中 / 猛）归到所在接触段，给出“轻擦段 vs 重击段”的 Σ 分布。
 *  (b) 重击段 = Σ ≥ 中位段 2 倍；取其中位值，按“单次重击段让 lock 0.50（× burstGuard）的陀螺 Δstress ∈ [0.10, 0.15]”
 *      给出 k_burst 区间（burstGuard 取 1 与 0.5 两种口径）。
 *  (c) 爆裂发生前，开 / 关爆裂判定的物理完全相同，所以对任意 k，第一次爆裂发生在哪一步可以在本次运行中逐步精确算出；
 *      若早于原终局（或超时）则该场会变成爆裂终结。输出 k 扫描下的爆裂终结占比（分组 + 总体），供按 §5.4 的终结分布目标定值。
 *
 * 用法：npx vitest run --config vitest.diag.config.ts tests/diag/burst-calib.diag.ts
 * 环境变量：
 *   BURST_OUT  输出 JSON（默认 test-results/burst/calib.json）
 *   BURST_SET  natural（默认：去掉受控摆放 CTRL 与针尖低功率 NNPOW）| all
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { test } from 'vitest';
import { BurstObserver, type BurstResistance, type ContactEpisode } from '../../src/game/battle/burst';
import type { AssembledBey } from '../../src/game/beys/parts/assemble';
import { loadRapier, PHYSICS_DT } from '../../src/game/physics/PhysicsWorld';
import { seeded } from '../motion/motionSim';
import { scenariosV2, setup, type R as RT, type Scn } from './stallprobe2.shared';

const log = (...a: unknown[]) => process.stderr.write(a.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ') + '\n');

/** v2.0 设计初值（params-v2.json）：Bit 抗爆护轴。目录里有 burstGuard 字段后以目录为准 */
const GUARD_V2: Record<string, number> = { 'rush-rubber': 0.9, 'gear-flat': 0.85, 'dome-ball': 0.5, 'needle-point': 0.35 };

/** 抗爆参数：优先读目录里的 v2 字段（ratchet.lock / bit.burstGuard），没有时回退到 disc.burstResistance + 设计初值 */
export function resistanceOf(spec: AssembledBey): BurstResistance {
  const s = spec as unknown as Record<string, Record<string, unknown>>;
  const rat = (s.ratchet ?? s.disc) as Record<string, unknown>;
  const bit = (s.bit ?? s.tip) as Record<string, unknown>;
  const lock = (rat.lock ?? rat.burstResistance) as number;
  const guard = (bit.burstGuard as number | undefined) ?? GUARD_V2[bit.id as string] ?? 1;
  return { lock, burstGuard: guard };
}

/** k 扫描网格（对数间隔） */
const K_GRID = Array.from({ length: 41 }, (_, i) => 0.002 * Math.pow(10, i / 20)); // 0.002 … 0.2

function q(a: number[], p: number): number {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1) + 0.5)))];
}
const r3 = (v: number) => Math.round(v * 1000) / 1000;

interface RunOut {
  name: string;
  group: string;
  steps: number;
  finish: string | null;
  loser: string | null;
  episodes: { start: number; last: number; touch: number; sum: number; peak: number; tier: string }[];
  /** 每个 k 的第一次爆裂：[步号, 爆裂方 0/1/2(同时)]；未爆裂为 null */
  burstAt: ([number, number] | null)[];
  res: [BurstResistance, BurstResistance];
}

function runOne(R: RT, sc: Scn): RunOut {
  const orig = Math.random;
  Math.random = seeded(sc.seed);
  try {
    const { pw, b, A, B } = setup(R, sc, { observeContacts: true });
    const cs = pw.contacts!;
    const res: [BurstResistance, BurstResistance] = [resistanceOf(A.spec), resistanceOf(B.spec)];
    const obs = new BurstObserver(PHYSICS_DT, res, null);
    const cum: [number, number][] = K_GRID.map(() => [0, 0]);
    const burstAt: ([number, number] | null)[] = K_GRID.map(() => null);
    const div = [res[0].lock * res[0].burstGuard, res[1].lock * res[1].burstGuard];
    const impacts: { step: number; tier: string }[] = [];
    let seen = 0;
    const max = Math.round((sc.maxSeconds ?? 60) / PHYSICS_DT);
    let s = 0;
    for (; s < max && !b.result; s++) {
      pw.step();
      const imp = cs.bodyPair('player', 'rival')?.normalImpulse ?? 0;
      obs.step(s, imp);
      if (imp > 0) {
        for (let k = 0; k < K_GRID.length; k++) {
          if (burstAt[k]) continue;
          const c = cum[k];
          c[0] += (K_GRID[k] * imp) / div[0];
          c[1] += (K_GRID[k] * imp) / div[1];
          const h0 = c[0] >= 1;
          const h1 = c[1] >= 1;
          if (h0 || h1) burstAt[k] = [s, h0 && h1 ? 2 : h0 ? 0 : 1];
        }
      }
      for (; seen < b.impacts.length; seen++) impacts.push({ step: s, tier: b.impacts[seen].tier });
    }
    obs.finish();
    const tierOf = (e: ContactEpisode) => {
      let best = 'none';
      const rank: Record<string, number> = { none: 0, light: 1, medium: 2, heavy: 3 };
      for (const i of impacts) if (i.step >= e.startStep - 2 && i.step <= e.lastStep && rank[i.tier] > rank[best]) best = i.tier;
      return best;
    };
    const out: RunOut = {
      name: sc.name,
      group: sc.group,
      steps: s,
      finish: b.result?.finish ?? null,
      loser: b.result?.loser ?? null,
      episodes: obs.closed.map((e) => ({ start: e.startStep, last: e.lastStep, touch: e.touchSteps, sum: e.sumImpulse, peak: e.peakImpulse, tier: tierOf(e) })),
      burstAt,
      res,
    };
    pw.dispose();
    return out;
  } finally {
    Math.random = orig;
  }
}

test('爆裂标定：接触段冲量分布与 k 扫描', async () => {
  const R = await loadRapier();
  const env = process.env;
  const set = env.BURST_SET ?? 'natural';
  const all = scenariosV2();
  const list = set === 'all' ? all : all.filter((s) => s.group !== 'CTRL' && s.group !== 'NNPOW');
  const t0 = performance.now();
  const runs = list.map((sc) => runOne(R, sc));
  const ms = Math.round(performance.now() - t0);

  const eps = runs.flatMap((r) => r.episodes);
  const sums = eps.map((e) => e.sum);
  const med = q(sums, 0.5);
  const heavy = sums.filter((v) => v >= 2 * med);
  const heavyMed = q(heavy, 0.5);
  const byTier: Record<string, { n: number; p50: number; p90: number; max: number }> = {};
  for (const t of ['none', 'light', 'medium', 'heavy']) {
    const v = eps.filter((e) => e.tier === t).map((e) => e.sum);
    byTier[t] = { n: v.length, p50: r3(q(v, 0.5)), p90: r3(q(v, 0.9)), max: r3(v.length ? Math.max(...v) : NaN) };
  }
  const dur = eps.map((e) => (e.last - e.start + 1) * PHYSICS_DT);
  const kRange = (g: number) => [r3((0.1 * 0.5 * g) / heavyMed), r3((0.15 * 0.5 * g) / heavyMed)];

  // k 扫描：爆裂早于原终局（或超时）即变为爆裂终结
  const groups = [...new Set(runs.map((r) => r.group))];
  const scan = K_GRID.map((k, ki) => {
    const turned = (r: RunOut) => {
      const b = r.burstAt[ki];
      return !!b && (r.finish === null || b[0] < r.steps - 1);
    };
    const share = (rs: RunOut[]) => (rs.length ? rs.filter(turned).length / rs.length : NaN);
    const times = runs.filter(turned).map((r) => r.burstAt[ki]![0] * PHYSICS_DT);
    return {
      k: Number(k.toPrecision(3)),
      burstShare: r3(share(runs)),
      medianBurstTime: r3(q(times, 0.5)),
      byGroup: Object.fromEntries(groups.map((g) => [g, r3(share(runs.filter((r) => r.group === g)))])),
    };
  });
  const finishes: Record<string, number> = {};
  for (const r of runs) finishes[r.finish ?? 'timeout'] = (finishes[r.finish ?? 'timeout'] ?? 0) + 1;

  const summary = {
    set,
    scenarios: runs.length,
    ms,
    finishesWithoutBurst: finishes,
    episodes: {
      count: eps.length,
      perRound: r3(eps.length / runs.length),
      sum: { p10: r3(q(sums, 0.1)), p50: r3(med), p75: r3(q(sums, 0.75)), p90: r3(q(sums, 0.9)), p99: r3(q(sums, 0.99)), max: r3(Math.max(...sums)) },
      durationS: { p50: r3(q(dur, 0.5)), p90: r3(q(dur, 0.9)), max: r3(Math.max(...dur)) },
      heavy: { rule: 'Σ ≥ 2 × 中位段', n: heavy.length, median: r3(heavyMed) },
      byImpactTier: byTier,
    },
    kFromHeavyEpisode: { 'lock0.5×guard1': kRange(1), 'lock0.5×guard0.5': kRange(0.5) },
    scan,
  };
  log(JSON.stringify(summary, null, 1));
  const out = env.BURST_OUT ?? 'test-results/burst/calib.json';
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ summary, runs }, null, 0));
}, 900000);
