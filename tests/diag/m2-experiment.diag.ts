/// <reference types="node" />
/**
 * M2 实验（v2.0 R3 / R8 / §6.3 爆裂标定 / §6.5 回合规则），一次 CI 运行给出全部结论。全部固定种子。
 *
 * A. golden 变化归因（回合裁判 M2-2）
 *    A1 回合上限临时设回 120 s：除“同时终结改判平局 / 口袋终结多 0.5 s 确认”外，180 场应与 golden 逐位一致
 *       —— 证明新裁判只读、不改物理，且与旧判定等价；
 *    A2 默认规则（60 s）：预注册的预期 = 只有 golden 中原时长 > 60 s 的场次变化，其余逐位一致。
 * B. 针尖探针（R3 驱动门限 0.2 → 0.1）：针尖对针尖 + 针尖对圆球，回合上限 120 s 以暴露僵持。
 *    预注册采用规则（v2.0 §3.6）：针尖对针尖 2 s 内重接触率（合并）≥ 90%，且每场“无接触低速段”最长 < 5 s；
 *    同时报告针尖速度分布（是否出现“缓慢爬行”）。未通过则保持 0.2。
 * C. 签名矩阵（v2.0 签名构筑 4 × 4 × 种子，默认 60 s 规则）：
 *    三个臂 base / R8 / R3+R8；每臂报告终结分布、轨道冲刺按 Bit 分布、默认对局（森衡 vs 磐盾）；
 *    爆裂发生前物理与“不判定爆裂”完全相同，所以 k 扫描可逐场精确离线计算（见 outcomeAtK）。
 *    k 按 §5.4 标准场爆裂终结目标 15–25%（取 20%）定值，并报告分构筑的被爆率与同时爆裂（镜像构筑）占比。
 *
 * 用法：npx vitest run --config vitest.diag.config.ts tests/diag/m2-experiment.diag.ts
 * 环境变量：M2_PARTS=A,B,C（默认全部）；M2_SEEDS=每个对阵的种子数（默认 20）；M2_GOLDEN_DUMP=1 时在 A2 后把新的 golden
 *          以 gzip + base64 分块打印到日志（行首 GOLDEN-B64），供无法下载 Artifact 的环境重建 tests/fixtures/repro-golden.json。
 */
import { gzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'vitest';
import golden from '../fixtures/repro-golden.json';
import { BURST_TUNING, EpisodeTracker } from '../../src/game/battle/burst';
import { MATCH_RULES, type RoundOutcome } from '../../src/game/battle/match';
import { BEY_TUNING } from '../../src/game/beys/BeyPhysics';
import { SIGNATURE_LIST, type SignatureBuild } from '../../src/game/beys/parts/catalog';
import { rivalCommand } from '../../src/game/launcher/launch';
import { loadRapier, PHYSICS_DT } from '../../src/game/physics/PhysicsWorld';
import { seeded } from '../motion/motionSim';
import { compareTraces, summarize, type TraceSummary } from '../repro/compare';
import { configFingerprint } from '../repro/config';
import { recordRun } from '../repro/recorder';
import { scenariosV2, setup, type R as RT, type Scn } from './stallprobe2.shared';

const out = (tag: string, v: unknown) => process.stdout.write(`${tag} ${JSON.stringify(v)}\n`);
const parts = new Set((process.env.M2_PARTS ?? 'A,B,C').split(','));
const SEEDS = Number(process.env.M2_SEEDS ?? 20);
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const G = golden as unknown as { generatedFrom: string; config: string; runs: TraceSummary[] };
const behavior = (s: TraceSummary): TraceSummary => ({ ...s, config: '' });

type Tune = Partial<typeof BEY_TUNING>;
function withTune<T>(patch: Tune, fn: () => T): T {
  const old: Record<string, number> = {};
  const t = BEY_TUNING as unknown as Record<string, number>;
  for (const [k, v] of Object.entries(patch)) {
    old[k] = t[k];
    t[k] = v as number;
  }
  try {
    return fn();
  } finally {
    Object.assign(t, old);
  }
}
function withRules<T>(patch: Partial<typeof MATCH_RULES>, fn: () => T): T {
  const old = { ...MATCH_RULES };
  Object.assign(MATCH_RULES, patch);
  try {
    return fn();
  } finally {
    Object.assign(MATCH_RULES, old);
  }
}

function q(a: number[], p: number): number {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1) + 0.5)))];
}
/** Wilson 95% 置信区间 */
function wilson(k: number, n: number): [number, number] {
  if (!n) return [NaN, NaN];
  const z = 1.96;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [r3((c - h) / d), r3((c + h) / d)];
}

let R: RT;
const rapier = async () => (R ??= await loadRapier());

// ───────────────────────────── A. golden 变化归因 ─────────────────────────────
/** 旧物理（M2 改动前）：轨道冲刺不门控、爆裂不判定 */
function withOldPhysics<T>(fn: () => T): T {
  const k = BURST_TUNING.kBurst;
  BURST_TUNING.kBurst = null;
  try {
    return withTune({ railGearOnly: 0 }, fn);
  } finally {
    BURST_TUNING.kBurst = k;
  }
}

test('A：golden 变化归因（A1 旧物理 + 120 s 应逐位一致；A2 旧物理 + 60 s 只影响原时长 > 60 s；A3 最终参数，可导出新 golden）', async () => {
  if (!parts.has('A')) return;
  await rapier();
  const all = scenariosV2();
  const gold = new Map(G.runs.map((g) => [g.name, g]));
  const classify = (label: string, rep: ReturnType<typeof compareTraces>, expected: (g: TraceSummary) => boolean) => {
    const rows = rep.diffs.map((d) => {
      const g = gold.get(d.name)!;
      return { name: d.name, channels: d.channels, steps: d.steps, golden: g.result, now: d.result[0], expected: expected(g) };
    });
    const unexpected = rows.filter((r) => !r.expected);
    out(`M2-A ${label}`, { identical: rep.identical, total: rep.total, missing: rep.missing, diffs: rows.length, unexpected: unexpected.length, rows });
    return rows;
  };
  const a1 = withOldPhysics(() => withRules({ roundTimeLimit: 120 }, () => all.map((sc) => summarize(recordRun(R, sc, { keyframes: false })))));
  classify('A1(old,120s)', compareTraces(a1.map(behavior), G.runs.map(behavior)), () => false);
  const a2 = withOldPhysics(() => all.map((sc) => summarize(recordRun(R, sc, { keyframes: false }))));
  const longOld = (g: TraceSummary) => (g.result?.duration ?? 0) > 60 || g.result === null;
  const rows = classify('A2(old,60s)', compareTraces(a2.map(behavior), G.runs.map(behavior)), longOld);
  const predicted = G.runs.filter((g) => longOld(g)).map((g) => g.name);
  out('M2-A prediction', { predictedChanged: predicted.length, actuallyChanged: rows.length, predictedButSame: predicted.filter((n) => !rows.some((r) => r.name === n)) });
  // A3：最终参数（R8 齿轮门控 + 已标定的爆裂 + 60 s），相对 A2 的变化全部来自 R8 与爆裂
  const a3 = all.map((sc) => summarize(recordRun(R, sc, { keyframes: false })));
  const vsA2 = compareTraces(a3.map(behavior), a2.map(behavior));
  const finish: Record<string, number> = {};
  for (const r of a3) finish[r.result?.finish ?? String(r.result?.winner ?? 'none')] = (finish[r.result?.finish ?? String(r.result?.winner ?? 'none')] ?? 0) + 1;
  out('M2-A A3(final) vs A2', { identical: vsA2.identical, diffs: vsA2.diffs.length, finishes: finish, bursts: a3.filter((r) => r.result?.finish === 'burst').map((r) => r.name) });
  if (process.env.M2_GOLDEN_DUMP) {
    const byName = [...a3].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const json = JSON.stringify({ generatedFrom: process.env.GITHUB_SHA ?? 'local', config: configFingerprint(R), runs: byName }, null, 1) + '\n';
    const b64 = gzipSync(Buffer.from(json)).toString('base64');
    const W = 3000;
    out('GOLDEN-META', { bytes: json.length, b64: b64.length, chunks: Math.ceil(b64.length / W) });
    for (let i = 0; i < b64.length; i += W) process.stdout.write(`GOLDEN-B64 ${i / W} ${b64.slice(i, i + W)}\n`);
  }
}, 1_800_000);

// ───────────────────────────── B. 针尖探针（R3） ─────────────────────────────
interface ProbeOut {
  name: string;
  steps: number;
  finish: string | null;
  /** 无接触低速段（双方水平速度 < 0.2 m/s 且无确认接触）最长秒数 */
  longestIdle: number;
  idleTotal: number;
  /** 接触段结束后 2 s 内重接触：可判定次数 / 命中次数 */
  recontactN: number;
  recontactHit: number;
  episodes: number;
  /** 两台针尖（或第一台）在转速比例 > 0.3 时的水平速度分位 */
  speedP10: number;
  speedP50: number;
  speedP90: number;
}

function probe(sc: Scn, maxSeconds: number): ProbeOut {
  const orig = Math.random;
  Math.random = seeded(sc.seed);
  try {
    const { pw, b, A, B } = setup(R, sc, { observeContacts: true });
    const cs = pw.contacts!;
    const ep = new EpisodeTracker(PHYSICS_DT);
    const ends: number[] = [];
    const starts: number[] = [];
    const speeds: number[] = [];
    let idle = 0;
    let longest = 0;
    let idleTotal = 0;
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
      const sa = Math.hypot(va.x, va.z);
      const sb = Math.hypot(vb.x, vb.z);
      if (A.spinRatio > 0.3) speeds.push(sa);
      if (sa < 0.2 && sb < 0.2 && imp <= 0) {
        idle += PHYSICS_DT;
        idleTotal += PHYSICS_DT;
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
    const o: ProbeOut = {
      name: sc.name,
      steps: s,
      finish: b.result ? `${b.result.winner ?? 'draw'}:${b.result.finish ?? b.result.cause}` : 'none',
      longestIdle: r3(longest),
      idleTotal: r3(idleTotal),
      recontactN: n,
      recontactHit: hit,
      episodes: ep.count,
      speedP10: r3(q(speeds, 0.1)),
      speedP50: r3(q(speeds, 0.5)),
      speedP90: r3(q(speeds, 0.9)),
    };
    pw.dispose();
    return o;
  } finally {
    Math.random = orig;
  }
}

test('B：针尖探针（R3 驱动门限）', async () => {
  if (!parts.has('B')) return;
  await rapier();
  const sig = (k: SignatureBuild['key']) => SIGNATURE_LIST.find((s) => s.key === k)!.loadout;
  const POW = [0.65, 0.8, 0.95];
  const extra: Scn[] = [];
  for (let i = 0; i < 8; i++) {
    const rnd = seeded(7000 + i);
    extra.push({ name: `PvP#${i}`, group: 'PvP', player: sig('pandun'), rival: sig('pandun'), pCmd: { power: POW[i % 3], aim: (rnd() - 0.5) * 1.2, tilt: 0 }, rCmd: rivalCommand(rnd), seed: 7000 + i, maxSeconds: 120, init: '磐盾镜像（针尖对针尖）' });
    extra.push({ name: `PvZ#${i}`, group: 'PvZ', player: sig('pandun'), rival: sig('ziyao'), pCmd: { power: POW[i % 3], aim: (rnd() - 0.5) * 1.2, tilt: 0 }, rCmd: rivalCommand(rnd), seed: 7100 + i, maxSeconds: 120, init: '磐盾 对 紫曜（针尖对圆球）' });
  }
  const list = [...scenariosV2().filter((s) => s.group === 'NNPOW'), ...extra];
  const arms: { arm: string; tune: Tune }[] = [
    { arm: 'base', tune: { driveMinGrip: 0.2, railGearOnly: 0 } },
    { arm: 'R3', tune: { driveMinGrip: 0.1, railGearOnly: 0 } },
    { arm: 'R8', tune: { driveMinGrip: 0.2, railGearOnly: 1 } },
    { arm: 'R3+R8', tune: { driveMinGrip: 0.1, railGearOnly: 1 } },
  ];
  for (const { arm, tune } of arms) {
    const rows = withRules({ roundTimeLimit: 120 }, () => withTune(tune, () => list.map((sc) => probe(sc, 120))));
    const nn = rows.filter((r) => !r.name.startsWith('PvZ'));
    const pool = (rs: ProbeOut[]) => {
      const n = rs.reduce((a, r) => a + r.recontactN, 0);
      const h = rs.reduce((a, r) => a + r.recontactHit, 0);
      return { n, hit: h, rate: n ? r3(h / n) : NaN, ci: wilson(h, n), maxIdle: Math.max(...rs.map((r) => r.longestIdle)), idleOver5: rs.filter((r) => r.longestIdle >= 5).length, meanDur: r3(rs.reduce((a, r) => a + r.steps, 0) / rs.length / 120) };
    };
    const nnPool = pool(nn);
    const pass = nnPool.rate >= 0.9 && nnPool.idleOver5 === 0;
    out(`M2-B ${arm}`, { needleVsNeedle: nnPool, needleVsBall: pool(rows.filter((r) => r.name.startsWith('PvZ'))), preRegisteredPass: pass, rows });
  }
}, 1_800_000);

// ───────────────────────────── C. 签名矩阵 + 爆裂 k 扫描 ─────────────────────────────
const K_GRID = Array.from({ length: 61 }, (_, i) => 0.0015 * Math.pow(10, i / 40)); // 0.0015 … 0.0474

interface RoundRec {
  p: string;
  r: string;
  natural: RoundOutcome | null;
  /** 回合实际推进的步数 */
  steps: number;
  /** 每个 k 的第一次爆裂：[步号, 0 = player / 1 = rival / 2 = 同一步] */
  burstAt: ([number, number] | null)[];
  dash: [number, number];
  episodes: number;
  sumImpulse: number;
}

function signatureRound(p: SignatureBuild, r: SignatureBuild, i: number, seed: number): RoundRec {
  const rnd = seeded(seed * 7 + 13);
  const POW = [0.65, 0.8, 0.95];
  const sc: Scn = { name: `${p.key}-${r.key}#${i}`, group: 'SIG', player: p.loadout, rival: r.loadout, pCmd: { power: POW[i % 3], aim: (rnd() - 0.5) * 1.2, tilt: 0 }, rCmd: rivalCommand(rnd), seed, maxSeconds: 61, init: '签名矩阵' };
  const orig = Math.random;
  Math.random = seeded(sc.seed);
  try {
    const { pw, b, A, B } = setup(R, sc, { observeContacts: true });
    const cs = pw.contacts!;
    const div = [A.spec.ratchet.lock * A.spec.bit.burstGuard, B.spec.ratchet.lock * B.spec.bit.burstGuard];
    let cum = 0; // Σ 实测法向冲量（两台之间）：k × cum / div ≥ 1 即爆裂
    const burstAt: ([number, number] | null)[] = K_GRID.map(() => null);
    const dash: [number, number] = [0, 0];
    const ep = new EpisodeTracker(PHYSICS_DT);
    const max = Math.round(61 / PHYSICS_DT);
    let s = 0;
    for (; s < max && !b.result; s++) {
      pw.step();
      if (A.dashing) dash[0]++;
      if (B.dashing) dash[1]++;
      const imp = cs.bodyPair('player', 'rival')?.normalImpulse ?? 0;
      ep.step(s, imp);
      if (imp > 0) {
        cum += imp;
        for (let k = 0; k < K_GRID.length; k++) {
          if (burstAt[k]) continue;
          const h0 = (K_GRID[k] * cum) / div[0] >= 1;
          const h1 = (K_GRID[k] * cum) / div[1] >= 1;
          if (h0 || h1) burstAt[k] = [s, h0 && h1 ? 2 : h0 ? 0 : 1];
        }
      }
    }
    const rec: RoundRec = { p: p.key, r: r.key, natural: b.judgeRound.outcome, steps: s, burstAt, dash, episodes: ep.count, sumImpulse: r3(cum) };
    pw.dispose();
    return rec;
  } finally {
    Math.random = orig;
  }
}

type Res = { kind: 'burst' | 'spin' | 'over' | 'xtreme' | 'draw' | 'none'; loser: 0 | 1 | null; burstDraw?: boolean };
/**
 * 某个 k 下这一回合的结果。爆裂前物理与不判定爆裂完全相同：
 *  - 爆裂步早于自然终结的发起步（超时则为判定步）→ 爆裂终结（同一步双方都到阈值 → 同时终结，平局）；
 *  - 落在自然终结的“发起—确认”窗口内：同一方 → 爆裂（优先级更高）；另一方 → 同时终结，平局；
 *  - 否则保持自然结果。
 */
function outcomeAtK(rec: RoundRec, ki: number | null): Res {
  const n = rec.natural;
  const natural = (): Res => (!n ? { kind: 'none', loser: null } : n.kind === 'draw' ? { kind: 'draw', loser: null } : { kind: n.finish as Res['kind'], loser: n.loser === 'player' ? 0 : 1 });
  if (ki === null) return natural();
  const b = rec.burstAt[ki];
  if (!b) return natural();
  const i0 = n ? Math.round(n.initiatedAt / PHYSICS_DT) : rec.steps;
  const c0 = n ? Math.round(n.time / PHYSICS_DT) - 1 : rec.steps;
  if (b[0] < i0 || !n) return b[1] === 2 ? { kind: 'draw', loser: null, burstDraw: true } : { kind: 'burst', loser: b[1] as 0 | 1 };
  if (b[0] <= c0 && n.kind === 'win') {
    const nl = n.loser === 'player' ? 0 : 1;
    if (b[1] === nl) return { kind: 'burst', loser: nl };
    return { kind: 'draw', loser: null, burstDraw: true };
  }
  return natural();
}

function shares(recs: RoundRec[], ki: number | null) {
  const c: Record<string, number> = { spin: 0, over: 0, xtreme: 0, burst: 0, draw: 0, none: 0, burstDraw: 0 };
  for (const rec of recs) {
    const o = outcomeAtK(rec, ki);
    c[o.kind]++;
    if (o.burstDraw) c.burstDraw++;
  }
  const n = recs.length;
  const f = (v: number) => r3(v / Math.max(1, n));
  return { n, spin: f(c.spin), over: f(c.over), xtreme: f(c.xtreme), burst: f(c.burst), draw: f(c.draw), none: f(c.none), burstDraw: f(c.burstDraw), burstCI: wilson(c.burst, n) };
}

test('C：签名矩阵（v2.0 签名构筑）终结分布、轨道冲刺与爆裂 k 标定', async () => {
  if (!parts.has('C')) return;
  await rapier();
  const arms: { arm: string; tune: Tune }[] = [
    { arm: 'base', tune: { driveMinGrip: 0.2, railGearOnly: 0 } },
    { arm: 'R8', tune: { driveMinGrip: 0.2, railGearOnly: 1 } },
    { arm: 'R3+R8', tune: { driveMinGrip: 0.1, railGearOnly: 1 } },
  ];
  const report: Record<string, unknown> = {};
  for (const { arm, tune } of arms) {
    const t0 = performance.now();
    const recs: RoundRec[] = withTune(tune, () => {
      const rs: RoundRec[] = [];
      SIGNATURE_LIST.forEach((p, pi) =>
        SIGNATURE_LIST.forEach((r, ri) => {
          for (let i = 0; i < SEEDS; i++) rs.push(signatureRound(p, r, i, 20000 + pi * 1000 + ri * 100 + i));
        }),
      );
      return rs;
    });
    const ms = Math.round(performance.now() - t0);
    // k 扫描：爆裂终结占比（不含同时爆裂平局）
    const scan = K_GRID.map((k, ki) => ({ k: Number(k.toPrecision(3)), ...shares(recs, ki) }));
    const target = 0.2;
    let kStar: number | null = null;
    let kiStar = -1;
    for (let i = 1; i < scan.length; i++) {
      const a = scan[i - 1].burst as number;
      const b = scan[i].burst as number;
      if (a < target && b >= target) {
        const f = (target - a) / Math.max(1e-9, b - a);
        kStar = Math.exp(Math.log(scan[i - 1].k) + f * (Math.log(scan[i].k) - Math.log(scan[i - 1].k)));
        kiStar = i;
        break;
      }
    }
    const band = scan.filter((s) => (s.burst as number) >= 0.15 && (s.burst as number) <= 0.25).map((s) => s.k);
    // 选定 k 处（取扫描网格上最接近目标的点）分构筑报告
    const ks = kiStar >= 0 ? kiStar : 0;
    const keys = SIGNATURE_LIST.map((s) => s.key);
    const per: Record<string, unknown> = {};
    for (const key of keys) {
      let rounds = 0;
      let burstLoss = 0;
      let wins = 0;
      let decided = 0;
      for (const rec of recs) {
        const side = rec.p === key ? 0 : rec.r === key ? 1 : -1;
        if (side < 0 || rec.p === rec.r) continue;
        rounds++;
        const o = outcomeAtK(rec, ks);
        if (o.loser === null) continue;
        decided++;
        if (o.loser !== side) wins++;
        if (o.kind === 'burst' && o.loser === side) burstLoss++;
      }
      per[key] = { rounds, decided, winRate: decided ? r3(wins / decided) : NaN, winCI: wilson(wins, decided), burstLossRate: rounds ? r3(burstLoss / rounds) : NaN };
    }
    const matrix: Record<string, Record<string, string>> = {};
    for (const p of keys) {
      matrix[p] = {};
      for (const r of keys) {
        const rs = recs.filter((x) => x.p === p && x.r === r);
        const c: Record<string, number> = {};
        let pw = 0;
        for (const rec of rs) {
          const o = outcomeAtK(rec, ks);
          c[o.kind] = (c[o.kind] ?? 0) + 1;
          if (o.loser === 1) pw++;
        }
        matrix[p][r] = `P胜${pw}/${rs.length} ` + Object.entries(c).map(([k, v]) => `${k}${v}`).join(' ');
      }
    }
    const dashBy: Record<string, number> = {};
    for (const rec of recs) {
      const pb = SIGNATURE_LIST.find((s) => s.key === rec.p)!.loadout.bit;
      const rb = SIGNATURE_LIST.find((s) => s.key === rec.r)!.loadout.bit;
      dashBy[pb] = (dashBy[pb] ?? 0) + rec.dash[0] * PHYSICS_DT;
      dashBy[rb] = (dashBy[rb] ?? 0) + rec.dash[1] * PHYSICS_DT;
    }
    const dflt = recs.filter((x) => x.p === 'senheng' && x.r === 'pandun');
    const natural = shares(recs, null);
    const durs = recs.map((x) => (x.natural ? x.natural.time : x.steps * PHYSICS_DT));
    const bursts = recs.map((x) => (ks >= 0 && x.burstAt[ks] ? x.burstAt[ks]![0] * PHYSICS_DT : null)).filter((v): v is number => v !== null);
    const rep = {
      ms,
      rounds: recs.length,
      natural,
      roundDuration: { p50: r3(q(durs, 0.5)), p10: r3(q(durs, 0.1)), p90: r3(q(durs, 0.9)), timeouts: recs.filter((x) => x.natural?.cause === 'timeout' || x.natural?.cause === 'timeout-tie').length },
      kStar: kStar === null ? null : Number(kStar.toPrecision(4)),
      kBand15to25: band.length ? [band[0], band[band.length - 1]] : null,
      atK: { ...scan[ks], burstTimeP50: r3(q(bursts, 0.5)) },
      perSignature: per,
      matrix,
      dashSecondsByBit: Object.fromEntries(Object.entries(dashBy).map(([k, v]) => [k, r3(v / recs.length)])),
      defaultSenhengVsPandun: { n: dflt.length, playerWinsNatural: dflt.filter((x) => x.natural?.winner === 'player').length, atK: shares(dflt, ks) },
      scan: scan.filter((_, i) => i % 3 === 0 || i === ks),
    };
    report[arm] = rep;
    out(`M2-C ${arm}`, rep);
  }
  mkdirSync('test-results/m2', { recursive: true });
  writeFileSync('test-results/m2/signature-matrix.json', JSON.stringify(report, null, 1));
}, 1_800_000);

// ───────────────────────────── D. 最终参数实测（爆裂实际触发） ─────────────────────────────
test('D：最终参数下的签名矩阵实测（爆裂实时判定、镜像同爆按转速裁决）', async () => {
  if (!parts.has('D')) return;
  await rapier();
  const recs: RoundRec[] = [];
  SIGNATURE_LIST.forEach((p, pi) =>
    SIGNATURE_LIST.forEach((r, ri) => {
      for (let i = 0; i < SEEDS; i++) recs.push(signatureRound(p, r, i, 20000 + pi * 1000 + ri * 100 + i));
    }),
  );
  const c: Record<string, number> = {};
  for (const x of recs) {
    const k = !x.natural ? 'none' : x.natural.kind === 'draw' ? 'draw' : (x.natural.finish as string);
    c[k] = (c[k] ?? 0) + 1;
  }
  const keys = SIGNATURE_LIST.map((s) => s.key);
  const per: Record<string, unknown> = {};
  for (const key of keys) {
    let decided = 0;
    let wins = 0;
    let burstLoss = 0;
    let n = 0;
    for (const x of recs) {
      const side = x.p === key ? 'player' : x.r === key ? 'rival' : null;
      if (!side || x.p === x.r) continue;
      n++;
      const o = x.natural;
      if (!o || o.kind !== 'win') continue;
      decided++;
      if (o.winner === side) wins++;
      if (o.finish === 'burst' && o.loser === side) burstLoss++;
    }
    per[key] = { n, decided, winRate: decided ? r3(wins / decided) : NaN, winCI: wilson(wins, decided), burstLossRate: n ? r3(burstLoss / n) : NaN };
  }
  const mirror = recs.filter((x) => x.p === x.r);
  const dflt = recs.filter((x) => x.p === 'senheng' && x.r === 'pandun');
  out('M2-D live', {
    rounds: recs.length,
    shares: Object.fromEntries(Object.entries(c).map(([k, v]) => [k, r3(v / recs.length)])),
    burstCI: wilson(c.burst ?? 0, recs.length),
    perSignature: per,
    mirrorDraws: mirror.filter((x) => x.natural?.kind === 'draw').length,
    mirrorRounds: mirror.length,
    defaultSenhengVsPandun: { n: dflt.length, playerWins: dflt.filter((x) => x.natural?.winner === 'player').length, finishes: dflt.map((x) => x.natural?.finish ?? x.natural?.kind) },
    durationP50: r3(q(recs.map((x) => x.natural?.time ?? x.steps / 120), 0.5)),
  });
}, 1_800_000);
