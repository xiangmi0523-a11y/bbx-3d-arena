/// <reference types="node" />
/**
 * 可对照的逐步记录（只读，不改变任何物理 / AI / 规则）。
 *
 * 场景集：沿用 Stage A / 探针 V2 的 180 个固定种子场景（tests/diag/stallprobe2.shared.ts 的 scenariosV2 / setup），
 * 每场的种子、部件、发射参数或受控摆放、时长都由场景描述确定。
 *
 * 每步记录 4 个通道，每个通道一条滚动 sha256，另按“块”（默认 120 步 = 1 秒）各记一个短哈希，
 * 两次运行不一致时可以直接定位到第一个不同的块，再用 detail 选项在该块内逐步展开到具体步：
 *  - physics：两台陀螺的位置、四元数、线速度、角速度、转速、倾斜（float64 原值；与 Stage A 的 fingerprint 完全相同）
 *  - intent ：战术状态、heading、authority、edgeW、脱困计时（AI 意图与控制输出）
 *  - contact：接触分类（contactClass）与接触反馈状态（contact.state）
 *  - battle ：撞击事件（本步新增）、命中/摩擦/脱困/死亡摇摆计数、僵持计时
 * 另外记录：关键帧（每块开始时的完整状态）、事件表（撞击、意图切换、终局，带步号）、初始状态、参数指纹、随机源报告。
 */
import { createHash } from 'node:crypto';
import type { ContactService } from '../../src/game/physics/ContactService';
import type { BattleSystem } from '../../src/game/battle/BattleSystem';
import type { BeyPhysics } from '../../src/game/beys/BeyPhysics';
import { loadRapier, PHYSICS_DT } from '../../src/game/physics/PhysicsWorld';
import { fingerprint, setup, type Scn } from '../diag/stallprobe2.shared';
import { configFingerprint } from './config';
import { withDeterminism, type DeterminismReport } from './determinism';

type R = Awaited<ReturnType<typeof loadRapier>>;
type Hash = ReturnType<typeof createHash>;

export const CHANNELS = ['physics', 'intent', 'contact', 'battle'] as const;
export type Channel = (typeof CHANNELS)[number];

export interface BeyState {
  p: number[];
  q: number[];
  v: number[];
  w: number[];
  spin: number;
  tilt: number;
  intent: string;
  heading: number;
  authority: number;
  breakout: number;
}

export interface TraceEvent {
  step: number;
  kind: 'impact' | 'intent' | 'result';
  data: unknown;
}

export interface Trace {
  name: string;
  group: string;
  seed: number;
  /** 场景描述（部件、发射参数、摆放、时长），JSON 原样 */
  scenario: unknown;
  config: string;
  initial: { player: BeyState; rival: BeyState };
  steps: number;
  chunkSteps: number;
  /** 全程滚动哈希（每通道） */
  final: Record<Channel, string>;
  /** 每块哈希（每通道，16 位十六进制） */
  chunks: Record<Channel, string[]>;
  /** 每块开始前的状态（第 k 个对应第 k*chunkSteps 步之前） */
  keyframes?: { step: number; player: BeyState; rival: BeyState }[];
  events: TraceEvent[];
  result: { winner: string; finish: string; duration: number } | null;
  counters: { hits: number; grinds: number; breakouts: number; wobbleBreaks: number; impacts: number; intentSwitches: number };
  random: { setup: DeterminismReport; run: DeterminismReport };
  /** detail 范围内逐步展开的完整状态（只在定位差异时使用） */
  detail?: { step: number; player: BeyState; rival: BeyState; contact: unknown; battle: unknown }[];
  /** observeContacts 时：ContactService 输出的全程哈希与计数（独立于原有四个通道，不进入 golden 摘要） */
  contactService?: { hash: string; events: number; begins: { body: number; collider: number }; physicalSteps: Record<string, number> };
}

export interface RecordOptions {
  chunkSteps?: number;
  keyframes?: boolean;
  /** 逐步展开 [from, to) 步的完整状态 */
  detail?: [number, number];
  /**
   * 开启只读 ContactService（阶段 1 第二项 A）。只影响新增的 contactService 字段；四个原有通道与 golden 必须不变，
   * 这正是“观测不改变物理”的回归证明。
   */
  observeContacts?: boolean;
}

const vec = (o: { x: number; y: number; z: number; w?: number }) => (o.w === undefined ? [o.x, o.y, o.z] : [o.x, o.y, o.z, o.w]);

export function beyState(b: BeyPhysics): BeyState {
  return {
    p: vec(b.body.translation()),
    q: vec(b.body.rotation()),
    v: vec(b.body.linvel()),
    w: vec(b.body.angvel()),
    spin: b.spin,
    tilt: b.tilt,
    intent: b.intent.state,
    heading: b.intent.heading,
    authority: b.intent.authority,
    breakout: b.breakout,
  };
}

function intentUpdate(h: Hash, beys: BeyPhysics[]) {
  const f = new Float64Array(4 * beys.length);
  let k = 0;
  let s = '';
  for (const b of beys) {
    s += `${b.intent.state};`;
    f.set([b.intent.heading, b.intent.authority, b.intent.edgeW, b.breakout], k);
    k += 4;
  }
  h.update(s);
  h.update(Buffer.from(f.buffer));
}

/** ContactService 本步输出的规范化摘要（身份、状态、几何、冲量、生命周期、事件），用于独立哈希 */
export function contactServiceDigest(cs: ContactService): string {
  const pairs = cs.colliderPairs
    .filter((p) => p.present || p.phase !== 'none')
    .map((p) => [p.key, p.dataStatus, p.manifolds, p.points, p.solverPoints, p.minDist, p.minSolverDist, p.normalImpulse, p.staleImpulsePoints, p.degenerateNormalPoints, +p.penetration, +p.impulse, +p.physicalContact, +p.proximity, p.phase, p.startStep, p.durationSteps, p.episodes, p.contactPoints.map((q) => [q.x, q.y, q.z, q.nx, q.ny, q.nz, +q.normalValid, q.dist, q.impulse, q.manifold])])
    .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  const bodies = cs.bodyPairs.map((b) => [b.key, b.colliderPairs, b.physicalPairs, b.normalImpulse, +b.physicalContact, +b.proximity, b.phase, b.startStep, b.durationSteps, b.episodes]).sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  const events = cs.events.map((e) => [e.kind, e.level, e.key, e.step, e.startStep, e.durationSteps, e.reason]).sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1));
  return JSON.stringify([cs.step, cs.stats, pairs, bodies, events]);
}

function contactSnapshot(b: BattleSystem) {
  return { cls: b.contactClass, st: b.contact.state };
}

function battleSnapshot(b: BattleSystem, newImpacts: unknown[]) {
  return { i: newImpacts, h: b.hits, g: b.grinds, bo: b.breakouts, wb: b.wobbleBreaks, sf: b.stallFor, wf: b.wobbleFor };
}

/** 跑一个场景并记录。setup 与逐步推进都在随机源控制下进行，分别报告随机调用。 */
export function recordRun(R: R, sc: Scn, opts: RecordOptions = {}): Trace {
  const chunkSteps = opts.chunkSteps ?? 120;
  const config = configFingerprint(R);
  // setup 与推进共用一条种子流（与 Stage A plainRun 相同：先 Math.random = seeded(seed)，再搭建并推进）
  let trace!: Trace;
  let setupReport!: DeterminismReport;
  const runRes = withDeterminism(sc.seed, (live) => {
    const { pw, b, A, B } = setup(R, sc, { observeContacts: !!opts.observeContacts });
    setupReport = structuredClone(live);
    // 标记 Rapier 求解区间：区分引擎内部计时读取与游戏代码读取时间（只包一层调用，不改参数和顺序）
    const world = pw.world;
    const engineStep = world.step.bind(world);
    world.step = ((...args: Parameters<typeof world.step>) => {
      live.inEngine = true;
      try {
        return engineStep(...args);
      } finally {
        live.inEngine = false;
      }
    }) as typeof world.step;
    const beys = [A, B];
    const hs = Object.fromEntries(CHANNELS.map((c) => [c, createHash('sha256')])) as Record<Channel, Hash>;
    const cs = Object.fromEntries(CHANNELS.map((c) => [c, createHash('sha256')])) as Record<Channel, Hash>;
    const chunks = Object.fromEntries(CHANNELS.map((c) => [c, [] as string[]])) as Record<Channel, string[]>;
    const keyframes: Trace['keyframes'] = [];
    const detail: NonNullable<Trace['detail']> = [];
    const events: TraceEvent[] = [];
    const initial = { player: beyState(A), rival: beyState(B) };
    const max = (sc.maxSeconds ?? 60) / PHYSICS_DT;
    let lastIntent = `${A.intent.state}|${B.intent.state}`;
    let switches = 0;
    let seenImpacts = 0;
    let s = 0;
    const csv = pw.contacts;
    const csHash = createHash('sha256');
    const csCount = { events: 0, begins: { body: 0, collider: 0 }, physicalSteps: {} as Record<string, number> };
    const closeChunk = () => {
      for (const c of CHANNELS) chunks[c].push(cs[c].digest('hex').slice(0, 16));
      for (const c of CHANNELS) cs[c] = createHash('sha256');
    };
    for (; s < max && !b.result; s++) {
      if (s % chunkSteps === 0) {
        if (s > 0) closeChunk();
        if (opts.keyframes !== false) keyframes.push({ step: s, player: beyState(A), rival: beyState(B) });
      }
      pw.step();
      // physics
      fingerprint(hs.physics, beys);
      fingerprint(cs.physics, beys);
      // intent
      intentUpdate(hs.intent, beys);
      intentUpdate(cs.intent, beys);
      const st = `${A.intent.state}|${B.intent.state}`;
      if (st !== lastIntent) {
        switches++;
        events.push({ step: s, kind: 'intent', data: st });
        lastIntent = st;
      }
      // contact
      const cj = JSON.stringify(contactSnapshot(b));
      hs.contact.update(cj);
      cs.contact.update(cj);
      // battle
      const fresh = b.impacts.slice(seenImpacts);
      seenImpacts = b.impacts.length;
      for (const e of fresh)
        events.push({ step: s, kind: 'impact', data: { tier: e.tier, strength: e.strength, approach: e.approach, impulse: e.impulse, x: e.x, z: e.z } });
      const bj = JSON.stringify(battleSnapshot(b, fresh));
      hs.battle.update(bj);
      cs.battle.update(bj);
      if (csv) {
        csHash.update(contactServiceDigest(csv));
        csCount.events += csv.events.length;
        for (const e of csv.events) if (e.kind === 'begin') csCount.begins[e.level]++;
        for (const bp of csv.bodyPairs) if (bp.physicalContact) csCount.physicalSteps[bp.key] = (csCount.physicalSteps[bp.key] ?? 0) + 1;
      }
      if (opts.detail && s >= opts.detail[0] && s < opts.detail[1])
        detail.push({ step: s, player: beyState(A), rival: beyState(B), contact: contactSnapshot(b), battle: battleSnapshot(b, fresh) });
    }
    closeChunk();
    const result = b.result ? { winner: b.result.winner, finish: b.result.finish, duration: b.result.duration } : null;
    if (result) events.push({ step: s - 1, kind: 'result', data: result });
    trace = {
      name: sc.name,
      group: sc.group,
      seed: sc.seed,
      scenario: { player: sc.player, rival: sc.rival, pCmd: sc.pCmd, rCmd: sc.rCmd, maxSeconds: sc.maxSeconds, place: sc.place ?? null, feel: !!sc.feel, phase: sc.phase ?? null },
      config,
      initial,
      steps: s,
      chunkSteps,
      final: Object.fromEntries(CHANNELS.map((c) => [c, hs[c].digest('hex')])) as Record<Channel, string>,
      chunks,
      ...(opts.keyframes !== false ? { keyframes } : {}),
      events,
      result,
      counters: { hits: b.hits, grinds: b.grinds, breakouts: b.breakouts, wobbleBreaks: b.wobbleBreaks, impacts: b.impacts.length, intentSwitches: switches },
      random: { setup: setupReport, run: { seededRandomCalls: 0, bypass: { performanceNow: 0, dateNow: 0, cryptoRandom: 0 }, engineTimerReads: 0 } },
      ...(opts.detail ? { detail } : {}),
      ...(csv ? { contactService: { hash: csHash.digest('hex'), ...csCount } } : {}),
    };
    pw.dispose();
  });
  // run 报告包含 setup + 推进两段；推进段调用数 = 总数 − setup 段
  const r = runRes.report;
  trace.random.run = {
    seededRandomCalls: r.seededRandomCalls - setupReport.seededRandomCalls,
    bypass: {
      performanceNow: r.bypass.performanceNow - setupReport.bypass.performanceNow,
      dateNow: r.bypass.dateNow - setupReport.bypass.dateNow,
      cryptoRandom: r.bypass.cryptoRandom - setupReport.bypass.cryptoRandom,
    },
    engineTimerReads: r.engineTimerReads - setupReport.engineTimerReads,
  };
  delete trace.random.setup.inEngine;
  return trace;
}

export async function rapier(): Promise<R> {
  return loadRapier();
}
