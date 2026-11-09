/// <reference types="node" />
/**
 * 阶段 1 第二项 A：ContactService 诊断（180 个固定种子场景）。
 *   npx vitest run --config vitest.diag.config.ts --execArgv=--expose-gc tests/diag/contact-service.diag.ts
 * 环境变量：CS_OUT=文件（默认 test-results/cs/diag.json）；CS_PART=compare|perf|alloc（默认全部）；CS_REPS=性能重复轮数（默认 2）
 *
 * compare：新服务的 player|rival 身体级接触与旧接触通道（BattleSystem.contactEvidence / contactClass、
 *          Rapier CollisionEvent started）逐步对照，统计差异与原因；同时统计每步接触对 / 接触点数量。
 * perf：   同一组场景 ContactService 关闭 / 开启交替运行，测总耗时；开启时逐步测 observe() 的耗时（hrtime）。
 * alloc：  在固定物理状态上重复调用 observe()，用 --expose-gc 前后的 heapUsed 差估算每次调用分配的字节数（期间无 GC 才采用）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PerformanceObserver } from 'node:perf_hooks';
import { cpus } from 'node:os';
import { test } from 'vitest';
import { loadRapier } from '../../src/game/physics/PhysicsWorld';
import { seeded } from '../motion/motionSim';
import { scenariosV2, setup, type R as RT, type Scn } from './stallprobe2.shared';

const log = (...a: unknown[]) => process.stderr.write(a.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ') + '\n');

function withSeed<T>(seed: number, fn: () => T): T {
  const orig = Math.random;
  Math.random = seeded(seed);
  try {
    return fn();
  } finally {
    Math.random = orig;
  }
}

const amax = (a: number[]) => a.reduce((m, x) => (x > m ? x : m), -Infinity);
const pct = (a: number[], q: number) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

function compareRun(R: RT, sc: Scn) {
  return withSeed(sc.seed, () => {
    const { pw, b, A, B } = setup(R, sc, { observeContacts: true });
    const cs = pw.contacts!;
    const c = {
      steps: 0,
      // 旧几何接触（求解器 dist ≤ 0）与新 penetration
      geo: { both: 0, oldOnly: 0, newOnly: 0 },
      // 旧冲量响应（全部流形点冲量之和 > 0）与新 impulse（只取本步求解器接触点）
      imp: { both: 0, oldOnly: 0, newOnly: 0, oldOnlyAllStale: 0, sumAbsDiff: 0, staleSteps: 0 },
      // 旧反馈 touching（geometric || impulse）与新 physicalContact
      touch: { both: 0, oldOnly: 0, newOnly: 0 },
      // 旧通道包围球门槛跳过的步里，新服务是否看到 player|rival 接触对
      skippedButNewPresent: 0,
      skippedButNewPhysical: 0,
      // Rapier CollisionEvent started（旧撞击结算触发器）当步新服务是否有真实接触
      started: { total: 0, physical: 0, proximityOnly: 0, neither: 0 },
      // 新服务计数
      bodyBegins: { pr: 0, pa: 0, ra: 0 },
      physicalSteps: { pr: 0, pa: 0, ra: 0 },
      proximityOnlySteps: { pr: 0 },
      stale: 0,
      degenerate: 0,
      matchIncomplete: 0,
      perStep: { pairs: [] as number[], manifolds: [] as number[], points: [] as number[], solverPoints: [] as number[] },
    };
    const max = Math.round((sc.maxSeconds ?? 60) * 120);
    for (let s = 0; s < max && !b.result; s++) {
      pw.step();
      c.steps++;
      const st = cs.stats;
      c.perStep.pairs.push(st.pairsEnumerated);
      c.perStep.manifolds.push(st.manifolds);
      c.perStep.points.push(st.points);
      c.perStep.solverPoints.push(st.solverPoints);
      c.stale += st.staleImpulsePoints;
      c.degenerate += st.degenerateNormalPoints;
      c.matchIncomplete += st.matchIncomplete;
      const pr = cs.bodyPair('player', 'rival');
      const pa = cs.bodyPair('player', 'arena');
      const ra = cs.bodyPair('rival', 'arena');
      for (const e of cs.events) if (e.level === 'body' && e.kind === 'begin') c.bodyBegins[e.key === 'player|rival' ? 'pr' : e.key === 'player|arena' ? 'pa' : 'ra']++;
      if (pr?.physicalContact) c.physicalSteps.pr++;
      if (pa?.physicalContact) c.physicalSteps.pa++;
      if (ra?.physicalContact) c.physicalSteps.ra++;
      if (pr?.proximity) c.proximityOnlySteps.pr++;
      const oe = b.contactEvidence;
      const oc = b.contactClass;
      const nPen = !!pr?.penetration;
      const nImp = !!pr?.impulse;
      const nPhys = !!pr?.physicalContact;
      const tally = (t: { both: number; oldOnly: number; newOnly: number }, o: boolean, n: boolean) => {
        if (o && n) t.both++;
        else if (o) t.oldOnly++;
        else if (n) t.newOnly++;
      };
      tally(c.geo, oc.geometric, nPen);
      tally(c.imp, oc.impulseResponse, nImp);
      tally(c.touch, oc.geometric || oc.impulseResponse, nPhys);
      const newImp = pr?.normalImpulse ?? 0;
      const oldImp = oe.valid ? oe.impulse : 0;
      c.imp.sumAbsDiff += Math.abs(oldImp - newImp);
      // 旧值多出来的部分全部来自非求解器点的旧冲量？
      let staleHere = 0;
      for (const p of cs.colliderPairs) if (p.present && p.a.owner === 'player' && p.b.owner === 'rival') staleHere += p.staleImpulsePoints;
      if (staleHere > 0) c.imp.staleSteps++;
      if (oc.impulseResponse && !nImp && staleHere > 0) c.imp.oldOnlyAllStale++;
      if (oe.skipped === 'bound') {
        if (pr && pr.colliderPairs > 0) c.skippedButNewPresent++;
        if (nPhys) c.skippedButNewPhysical++;
      }
      for (const pair of pw.startedContacts) {
        const ab = (A.ownsCollider(pair.a) && B.ownsCollider(pair.b)) || (A.ownsCollider(pair.b) && B.ownsCollider(pair.a));
        if (!ab) continue;
        c.started.total++;
        if (nPhys) c.started.physical++;
        else if (pr?.proximity) c.started.proximityOnly++;
        else c.started.neither++;
      }
    }
    pw.dispose();
    return c;
  });
}

type ObserveTiming = { observeNs: number[]; stepNs: number[]; contactSteps: boolean[]; points: number[] };

function timedRun(R: RT, sc: Scn, observe: boolean, perStep: ObserveTiming | null): number {
  return withSeed(sc.seed, () => {
    const { pw, b } = setup(R, sc, { observeContacts: observe });
    const cs = pw.contacts;
    if (cs && perStep) {
      const inner = cs.observe.bind(cs);
      cs.observe = () => {
        const t = process.hrtime.bigint();
        inner();
        perStep.observeNs.push(Number(process.hrtime.bigint() - t));
        perStep.contactSteps.push(!!cs.bodyPair('player', 'rival')?.physicalContact);
        perStep.points.push(cs.stats.points);
      };
    }
    const max = Math.round((sc.maxSeconds ?? 60) * 120);
    const t0 = process.hrtime.bigint();
    for (let s = 0; s < max && !b.result; s++) {
      if (perStep) {
        const t = process.hrtime.bigint();
        pw.step();
        perStep.stepNs.push(Number(process.hrtime.bigint() - t));
      } else pw.step();
    }
    const ns = Number(process.hrtime.bigint() - t0);
    pw.dispose();
    return ns;
  });
}

test('ContactService 诊断', async () => {
  const R = (await loadRapier()) as RT;
  const part = process.env.CS_PART ?? 'compare,perf,alloc';
  const out = process.env.CS_OUT ?? 'test-results/cs/diag.json';
  const all = scenariosV2();
  const report: Record<string, unknown> = { node: process.version, platform: `${process.platform}-${process.arch}`, cpu: cpus()[0]?.model, cpus: cpus().length };

  if (part.includes('compare')) {
    const per: Record<string, ReturnType<typeof compareRun>> = {};
    const t0 = Date.now();
    for (const sc of all) per[sc.name] = compareRun(R, sc);
    const sum = (f: (c: ReturnType<typeof compareRun>) => number) => Object.values(per).reduce((a, c) => a + f(c), 0);
    const flat = (k: keyof ReturnType<typeof compareRun>['perStep']) => Object.values(per).flatMap((c) => c.perStep[k]);
    const dist = (k: keyof ReturnType<typeof compareRun>['perStep']) => {
      const a = flat(k);
      return { mean: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2), p50: pct(a, 0.5), p99: pct(a, 0.99), max: amax(a) };
    };
    const totals = {
      scenarios: all.length,
      steps: sum((c) => c.steps),
      geo: { both: sum((c) => c.geo.both), oldOnly: sum((c) => c.geo.oldOnly), newOnly: sum((c) => c.geo.newOnly) },
      imp: { both: sum((c) => c.imp.both), oldOnly: sum((c) => c.imp.oldOnly), newOnly: sum((c) => c.imp.newOnly), oldOnlyAllStale: sum((c) => c.imp.oldOnlyAllStale), staleSteps: sum((c) => c.imp.staleSteps), sumAbsDiff: +sum((c) => c.imp.sumAbsDiff).toFixed(4) },
      touch: { both: sum((c) => c.touch.both), oldOnly: sum((c) => c.touch.oldOnly), newOnly: sum((c) => c.touch.newOnly) },
      skippedButNewPresent: sum((c) => c.skippedButNewPresent),
      skippedButNewPhysical: sum((c) => c.skippedButNewPhysical),
      started: { total: sum((c) => c.started.total), physical: sum((c) => c.started.physical), proximityOnly: sum((c) => c.started.proximityOnly), neither: sum((c) => c.started.neither) },
      bodyBegins: { pr: sum((c) => c.bodyBegins.pr), pa: sum((c) => c.bodyBegins.pa), ra: sum((c) => c.bodyBegins.ra) },
      physicalSteps: { pr: sum((c) => c.physicalSteps.pr), pa: sum((c) => c.physicalSteps.pa), ra: sum((c) => c.physicalSteps.ra) },
      proximityOnlySteps: { pr: sum((c) => c.proximityOnlySteps.pr) },
      staleImpulsePoints: sum((c) => c.stale),
      degenerateNormalPoints: sum((c) => c.degenerate),
      matchIncomplete: sum((c) => c.matchIncomplete),
      perStep: { pairs: dist('pairs'), manifolds: dist('manifolds'), points: dist('points'), solverPoints: dist('solverPoints') },
      ms: Date.now() - t0,
    };
    for (const c of Object.values(per)) (c as { perStep?: unknown }).perStep = undefined;
    report.compare = { totals, perScenario: per };
    log('compare', totals);
  }

  if (part.includes('perf')) {
    const reps = Number(process.env.CS_REPS ?? 2);
    const totals: { off: number[]; on: number[] } = { off: [], on: [] };
    // 预热
    for (const sc of all.slice(0, 5)) {
      timedRun(R, sc, false, null);
      timedRun(R, sc, true, null);
    }
    for (let r = 0; r < reps; r++) {
      for (const mode of r % 2 === 0 ? ['off', 'on'] : ['on', 'off']) {
        let ns = 0;
        for (const sc of all) ns += timedRun(R, sc, mode === 'on', null);
        totals[mode as 'off' | 'on'].push(ns / 1e6);
      }
    }
    // 逐步 observe 耗时（开启时），按场景类型分组
    const timing: ObserveTiming = { observeNs: [], stepNs: [], contactSteps: [], points: [] };
    const byGroup: Record<string, { observeNs: number[]; stepNs: number[] }> = {};
    for (const sc of all) {
      const t: ObserveTiming = { observeNs: [], stepNs: [], contactSteps: [], points: [] };
      timedRun(R, sc, true, t);
      const g = (byGroup[sc.group] ??= { observeNs: [], stepNs: [] });
      for (let i = 0; i < t.observeNs.length; i++) {
        g.observeNs.push(t.observeNs[i]);
        timing.observeNs.push(t.observeNs[i]);
        timing.contactSteps.push(t.contactSteps[i]);
        timing.points.push(t.points[i]);
      }
      for (const x of t.stepNs) {
        g.stepNs.push(x);
        timing.stepNs.push(x);
      }
    }
    const us = (a: number[]) => ({ n: a.length, mean: +(a.reduce((x, y) => x + y, 0) / a.length / 1000).toFixed(2), p50: +(pct(a, 0.5) / 1000).toFixed(2), p99: +(pct(a, 0.99) / 1000).toFixed(2), max: +(amax(a) / 1000).toFixed(1) });
    const contactObs = timing.observeNs.filter((_, i) => timing.contactSteps[i]);
    const noContactObs = timing.observeNs.filter((_, i) => !timing.contactSteps[i]);
    const hiPts = pct(timing.points, 0.95);
    const highPointObs = timing.observeNs.filter((_, i) => timing.points[i] >= hiPts);
    const perf = {
      totalsMs: totals,
      overheadPct: +(((totals.on.reduce((a, b) => a + b, 0) / totals.off.reduce((a, b) => a + b, 0)) - 1) * 100).toFixed(2),
      observeUs: us(timing.observeNs),
      stepUsIncludingObserve: us(timing.stepNs),
      observeUsWhenBeysTouching: us(contactObs),
      observeUsWhenBeysApart: us(noContactObs),
      observeUsTop5PctPoints: { minPoints: hiPts, ...us(highPointObs) },
      byGroup: Object.fromEntries(Object.entries(byGroup).map(([g, v]) => [g, { observe: us(v.observeNs), step: us(v.stepNs) }])),
    };
    report.perf = perf;
    log('perf', { ...perf, byGroup: undefined });
  }

  if (part.includes('alloc')) {
    const gc = (globalThis as { gc?: () => void }).gc;
    if (!gc) {
      report.alloc = 'skipped: run with --execArgv=--expose-gc';
    } else {
      let gcs = 0;
      const obs = new PerformanceObserver((l) => (gcs += l.getEntries().length));
      obs.observe({ entryTypes: ['gc'] });
      const samples: { name: string; step: number; points: number; bytesPerObserve: number; gcDuring: number }[] = [];
      for (const name of ['AvD#1', 'NNPOW 0.3#1', 'CTRL wall NN#0']) {
        const sc = all.find((s) => s.name === name) ?? all[0];
        withSeed(sc.seed, () => {
          const { pw } = setup(R, sc, { observeContacts: true });
          const cs = pw.contacts!;
          for (const at of [600, 2400]) {
            while (cs.step < at) pw.step();
            for (let i = 0; i < 200; i++) cs.observe(); // 预热（对象池到位）
            const K = 2000;
            gc();
            const g0 = gcs;
            const h0 = process.memoryUsage().heapUsed;
            for (let i = 0; i < K; i++) cs.observe();
            const h1 = process.memoryUsage().heapUsed;
            samples.push({ name: sc.name, step: at, points: cs.stats.points, bytesPerObserve: Math.round((h1 - h0) / K), gcDuring: gcs - g0 });
          }
          pw.dispose();
        });
      }
      obs.disconnect();
      report.alloc = samples;
      log('alloc', samples);
    }
  }

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 1));
}, 7_200_000);
