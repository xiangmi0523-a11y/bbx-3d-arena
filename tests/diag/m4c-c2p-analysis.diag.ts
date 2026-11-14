/// <reference types="node" />
/**
 * M4-C · C2-P 判定（docs/engineering/m4c-c2-preregistration.md §6.4、§7.1–§7.3、§8.1–§8.5、§10，冻结于 1aab164）。
 * 读取 test-results/ 下的实验臂输出（c2p-<set>-<arm>.jsonl）、覆盖率模拟（c2p-cov.jsonl）、耗时（c2p-timing.jsonl），
 * 按预注册的口径计算每臂每个条件的状态：S = 满足、N = 不满足、U = 不确定、F = 统计分析失败。不修改任何门槛、样本或口径。
 * 环境变量：C2P_SET = S1（四臂筛选）| S4（P0 + C2P_ARM 指定的一臂，独立确认，不合并 S1）。
 * 输出行首 C2P-AN-（同时写入 test-results/c2p-analysis-<set>.jsonl）。
 *
 * 实现中需要说明的口径选择（预注册未逐字规定，按最接近原文的方式实现，并在结果报告中列出）：
 *  1. §8.3 的“不确定区间”（E1a / E1c / E1d / E5 差 3 个百分点内、E1b 0.2 s、E4 0.1、P7a 2 个百分点、P7b 1 s）列在“第一步：S1 筛选”下，
 *     所以只用于 S1；S4 按门槛严格判定（P4、P8 的样本不足仍为不确定）。
 *  2. P4 的“任一组观测 < 30”对候选臂与 P0 的 G_A / G_D 都检查（Δ − Δ_P0 需要两臂四组）。
 *  3. 区间方法的可用性取覆盖率模拟：Q1、Q2（单组中位）、Q3（单臂 Δ）、Q4（配对连续）、Q5（配对二元）各自的全部“验收”用例 C_cons ∈ [0.93, 0.97]
 *     才算该方法通过测试（§7.1.6、§7.1.8 最后一段）；未通过的方法不报告区间，依赖它的条件记为不确定。
 *  4. 计算结果为 NaN（无可计算的观测，例如没有中转速撞击）时记为不确定并注明“无可计算观测”。
 */
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'vitest';
import { median } from './m4.metrics';
import { chiSquare2xK, wilson } from './m5b.shared';
import { mcnemar } from './c2p.math';
import { stratBootstrap, type BootResult, type BootStat, type StatValue } from './c2p.stats';
import { ARMS, emit, GROUP, KEYS, type ArmName, type RoundRow, type S3Row, type SetName, type SoloRow } from './m4c-c2p.shared';

type St = 'S' | 'N' | 'U' | 'F';
const B = 2000;
const SEED = 12345;
const worst = (xs: St[]): St => (xs.includes('F') ? 'F' : xs.includes('N') ? 'N' : xs.includes('U') ? 'U' : 'S');

interface ArmData {
  arm: ArmName;
  rows: RoundRow[];
  solo: SoloRow[];
  s3: S3Row[];
  sum: Record<string, unknown> & { determinism: { identical: boolean }; audit: { badSteps: number; badRounds: number; ledgerResidualMax: number }; checks: Record<string, number>; ownShare: number };
}

function load(set: SetName, arm: ArmName): ArmData | null {
  const f = `test-results/c2p-${set}-${arm}.jsonl`;
  if (!existsSync(f)) return null;
  const d: ArmData = { arm, rows: [], solo: [], s3: [], sum: null as never };
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const o = JSON.parse(line);
    if (o.t === 'R') d.rows.push(o);
    else if (o.t === 'S2') d.solo.push(o);
    else if (o.t === 'S3') d.s3.push(o);
    else if (o.arm && o.determinism) d.sum = o;
  }
  d.rows.sort((a, b) => a.h - b.h || a.i - b.i);
  return d;
}

// ───────────────────────────── 覆盖率模拟 → 方法是否通过测试 ─────────────────────────────

function methods() {
  const f = 'test-results/c2p-cov.jsonl';
  const rows: Record<string, unknown>[] = existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const cases = new Set(rows.map((r) => r.c as number));
  const complete = Array.from({ length: 20 }, (_, i) => i).every((c) => cases.has(c));
  const ok = (q: string) => complete && rows.filter((r) => r.q === q && r.role === '验收').every((r) => r.withinAccept && r.failedDatasets === 0);
  const fails = rows.filter((r) => r.role === '验收' && (!r.withinAccept || (r.failedDatasets as number) > 0)).map((r) => `c${r.c} ${r.q}: C_cons = ${r.C_cons}`);
  const smallSample = rows.some((r) => (r.c as number) <= 2 && (r.q === 'Q2' || r.q === 'Q3') && (r.C_cons as number) < 0.93);
  return { complete, Q1: ok('Q1'), Q2: ok('Q2'), Q3: ok('Q3'), Q4: ok('Q4'), Q5: ok('Q5'), smallSampleRule: smallSample, fails, rows };
}
type Methods = ReturnType<typeof methods>;

// ───────────────────────────── 每臂的量 ─────────────────────────────

/** 非超时的自转终结（fp 只在 cause = finish 时存在） */
const spinFin = (r: RoundRow) => r.kind === 'win' && r.finish === 'spin' && !!r.fp;

function armMetrics(d: ArmData) {
  const rows = d.rows;
  const n = rows.length;
  const sp = rows.filter(spinFin);
  const destab = sp.filter((r) => r.fp!.destab);
  const rhos = destab.map((r) => r.fp!.rho).filter((x): x is number => typeof x === 'number');
  const E1a = destab.length / sp.length;
  const E1b = median(destab.map((r) => r.fp!.D));
  const E1c = rhos.length ? rhos.filter((x) => x > 0.3).length / rhos.length : NaN;
  const E1d = sp.filter((r) => r.fp!.winnerEx < r.fp!.loserEx).length / sp.length;
  const kn = rows.flatMap((r) => r.kn.map((k) => ({ key: k[0] === 0 ? r.p : r.r, ratio: k[1], recover: k[2], censored: k[3] === 1, bNear: k[4] === 1 })));
  const rec = (lo: number, hi: number, f = (_k: (typeof kn)[number]) => true) => kn.filter((k) => k.ratio >= lo && k.ratio < hi && !k.censored && f(k)).map((k) => k.recover);
  const E4 = median(rec(0.3, 0.6)) / median(rec(0.6, 2));
  const E5 = rows.filter((r) => r.frozen < 3).length / n;
  const own = rows.filter((r) => r.own).length / n;
  const durs = rows.map((r) => r.dur);
  const durMed = median(durs);
  const atLimit = rows.filter((r) => r.dur >= 60 - 1e-6).length / n;
  const burst = rows.filter((r) => r.kind === 'win' && r.finish === 'burst').length;
  const sp1 = (key: string) => rows.filter((r) => r.p !== r.r && r.sp1).flatMap((r) => [r.p === key ? r.sp1![0] : NaN, r.r === key ? r.sp1![1] : NaN]).filter(Number.isFinite);
  const opening = median(sp1('lieren')) / median(sp1('pandun'));
  const fv = [0, 0, 0, 0];
  for (const r of rows) {
    if (r.kind !== 'win') fv[3]++;
    else if (r.finish === 'spin') fv[0]++;
    else if (r.finish === 'burst') fv[1]++;
    else fv[2]++;
  }
  const timeouts = rows.filter((r) => r.cause === 'timeout').length;
  const timeoutTies = rows.filter((r) => r.cause === 'timeout-tie').length;
  const perBuild = Object.fromEntries(
    KEYS.map((k) => {
      const L = sp.filter((r) => r.fp!.lk === k);
      const Ld = L.filter((r) => r.fp!.destab);
      const [wl, wh] = wilson(Ld.length, L.length);
      const knK = (lo: number, hi: number) => kn.filter((x) => x.key === k && x.ratio >= lo && x.ratio < hi);
      const kb = (lo: number, hi: number) => {
        const g = knK(lo, hi);
        const done = g.filter((x) => !x.censored).map((x) => x.recover);
        const cen = g.filter((x) => x.censored).length;
        return { n: g.length, recoverP50: median(done), censored: cen, censoredShare: g.length ? cen / g.length : null, censoredWilson: wilson(cen, g.length) };
      };
      return [
        k,
        {
          spinLosers: L.length,
          destab: Ld.length,
          E1a: L.length ? Ld.length / L.length : NaN,
          E1aWilson: [wl, wh],
          onsetP50: median(L.map((r) => r.fp!.onset)),
          onsetDestabP50: median(Ld.map((r) => r.fp!.onset)),
          durationP50: median(Ld.map((r) => r.fp!.D)),
          /** §6.3 分层：失衡过程内是否出现 B 类（轴杆参与接地） */
          withB: { n: L.filter((r) => r.fp!.bIn).length, E1a: L.filter((r) => r.fp!.bIn).length ? L.filter((r) => r.fp!.bIn && r.fp!.destab).length / L.filter((r) => r.fp!.bIn).length : null },
          withoutB: { n: L.filter((r) => !r.fp!.bIn).length, E1a: L.filter((r) => !r.fp!.bIn).length ? L.filter((r) => !r.fp!.bIn && r.fp!.destab).length / L.filter((r) => !r.fp!.bIn).length : null },
          knocks: { high: kb(0.6, 2), mid: kb(0.3, 0.6), low: kb(0, 0.3) },
          knocksB: { nearB: median(kn.filter((x) => x.key === k && x.bNear && !x.censored).map((x) => x.recover)), noB: median(kn.filter((x) => x.key === k && !x.bNear && !x.censored).map((x) => x.recover)), nNearB: kn.filter((x) => x.key === k && x.bNear).length },
          /** 作为输方的终结类型分布（§8.2 P4 解释边界第 2 项） */
          loserFinish: rows.reduce<Record<string, number>>((a, r) => {
            if (r.kind === 'win' && r.lose !== null && (r.lose === 0 ? r.p : r.r) === k) {
              const t = r.cause === 'timeout' ? 'timeout' : r.finish!;
              a[t] = (a[t] ?? 0) + 1;
            }
            return a;
          }, {}),
          drawsOrNone: rows.filter((r) => r.kind !== 'win' && (r.p === k || r.r === k)).length,
        },
      ];
    }),
  );
  return { n, spinFinishes: sp.length, E1a, E1b, E1c, E1d, E1n: { spin: sp.length, destab: destab.length, rho: rhos.length }, E4, E4n: { mid: rec(0.3, 0.6).length, high: rec(0.6, 2).length }, E5, own, durMed, atLimit, burst, burstShare: burst / n, burstWilson: wilson(burst, n), opening, finishVector: fv, timeouts, timeoutTies, perBuild };
}
type AM = ReturnType<typeof armMetrics>;

// ───────────────────────────── 状态函数（§8.3） ─────────────────────────────

const ge = (v: number, thr: number, margin: number, set: SetName): St => (Number.isNaN(v) ? 'U' : v >= thr ? 'S' : set === 'S1' && v >= thr - margin ? 'U' : 'N');
const inRange = (v: number, lo: number, hi: number, margin: number, set: SetName): St => (Number.isNaN(v) ? 'U' : v >= lo && v <= hi ? 'S' : set === 'S1' && v >= lo - margin && v <= hi + margin ? 'U' : 'N');

// ───────────────────────────── P4（§8.2） ─────────────────────────────

type Lab = { g: 'A' | 'D'; v: number; k: string } | null;
const label = (r: RoundRow): Lab => (spinFin(r) ? { g: GROUP[r.fp!.lk], v: r.fp!.onset, k: r.fp!.lk } : null);

function p4(set: SetName, rowsX: RoundRow[], rowsP0: RoundRow[], M: Methods, restrict?: (rx: RoundRow, r0: RoundRow) => boolean) {
  const seeds = set === 'S1' ? 20 : 40;
  const layers: { x: Lab; p: Lab }[][] = Array.from({ length: 16 }, () => []);
  rowsX.forEach((rx, j) => {
    const r0 = rowsP0[j];
    if (rx.seed !== r0.seed || rx.h !== r0.h || rx.i !== r0.i) throw new Error('两臂的场景行未对齐');
    const keep = !restrict || restrict(rx, r0);
    layers[rx.h].push({ x: keep ? label(rx) : null, p: keep ? label(r0) : null });
  });
  if (layers.some((l) => l.length !== seeds)) throw new Error('层的行数与集合不符');
  const all = layers.flat();
  const cnt = (who: 'x' | 'p', g: 'A' | 'D') => all.filter((r) => r[who]?.g === g).length;
  const n = { armA: cnt('x', 'A'), armD: cnt('x', 'D'), p0A: cnt('p', 'A'), p0D: cnt('p', 'D') };
  const med = (rows: { x: Lab; p: Lab }[], who: 'x' | 'p', g: 'A' | 'D', arm: string): StatValue => {
    const v = rows.filter((r) => r[who]?.g === g).map((r) => r[who]!.v);
    return v.length ? median(v) : { empty: [{ group: `G_${g}`, arm }] };
  };
  const sub = (a: StatValue, b: StatValue): StatValue => (typeof a === 'number' && typeof b === 'number' ? a - b : { empty: [...(typeof a === 'number' ? [] : a.empty), ...(typeof b === 'number' ? [] : b.empty)] });
  const delta = (rows: { x: Lab; p: Lab }[], who: 'x' | 'p') => sub(med(rows, who, 'A', who === 'x' ? 'arm' : 'P0'), med(rows, who, 'D', who === 'x' ? 'arm' : 'P0'));
  const stats: BootStat<{ x: Lab; p: Lab }>[] = [
    { name: 'Δ_arm', fn: (rows) => delta(rows, 'x') },
    { name: 'Δ_P0', fn: (rows) => delta(rows, 'p') },
    { name: 'Δ_arm − Δ_P0', fn: (rows) => sub(delta(rows, 'x'), delta(rows, 'p')) },
    { name: 'median G_A arm', fn: (rows) => med(rows, 'x', 'A', 'arm') },
    { name: 'median G_D arm', fn: (rows) => med(rows, 'x', 'D', 'arm') },
  ];
  const res = stratBootstrap(layers, B, SEED, stats);
  const get = (nm: string) => res.find((r) => r.name === nm)!;
  const d = get('Δ_arm');
  const dd = get('Δ_arm − Δ_P0');
  const reasons: string[] = [];
  let st: St;
  const small = Math.min(n.armA, n.armD, n.p0A, n.p0D) < 30;
  if (dd.failed || d.failed) {
    st = 'F';
    reasons.push(`统计分析失败：${dd.failed ?? d.failed}`);
  } else if (small || dd.unstable || M.smallSampleRule) {
    st = 'U';
    if (small) reasons.push(`原始样本不足：G_A ${n.armA} / G_D ${n.armD}（臂），G_A ${n.p0A} / G_D ${n.p0D}（P0）；下限 30`);
    if (dd.unstable) reasons.push(`重抽样不稳定：退化 ${dd.degenerate} / ${B}（${JSON.stringify(dd.degenerateBy)}）`);
    if (M.smallSampleRule) reasons.push('§7.1.3 小样本规则：覆盖率模拟 c = 0–2 的 Q2 或 Q3 低于 0.93 → 涉及 G_D 的区间一律重抽样不稳定');
  } else if ((d.point ?? NaN) < 0.03) {
    st = 'N';
    reasons.push(`Δ = ${d.point} < 0.03`);
  } else if (!M.Q4) {
    st = 'U';
    reasons.push('配对连续 bootstrap（Q4）未通过覆盖率验收，Δ − Δ_P0 的区间不可用');
  } else if (dd.lo > 0) st = 'S';
  else {
    st = 'U';
    reasons.push(`Δ ≥ 0.03 但 Δ − Δ_P0 的 CI 下限 ${dd.lo} ≤ 0`);
  }
  const iv = (r: BootResult, ok: boolean) => ({ point: r.point, lo: ok ? r.lo : null, hi: ok ? r.hi : null, intervalReported: ok, valid: r.valid, degenerate: r.degenerate, degenerateBy: r.degenerateBy, unstable: r.unstable, failed: r.failed });
  return {
    status: st,
    reasons,
    n,
    /** G_A / G_D 的构成（§8.2：必须写明 G_D 几乎全部来自紫曜） */
    composition: Object.fromEntries((['x', 'p'] as const).map((who) => [who === 'x' ? 'arm' : 'P0', Object.fromEntries(KEYS.map((k) => [k, all.filter((r) => r[who]?.k === k).length]))])),
    delta: iv(d, M.Q3 && !M.smallSampleRule),
    deltaP0: iv(get('Δ_P0'), M.Q3 && !M.smallSampleRule),
    deltaMinusP0: iv(dd, M.Q4 && !M.smallSampleRule),
    medianGA: iv(get('median G_A arm'), M.Q1),
    medianGD: iv(get('median G_D arm'), M.Q2 && !M.smallSampleRule),
  };
}

/** §8.2 P4 解释边界第 3 项：按配对种子的构成变化、输方力度与对阵分布 */
function composition(rowsX: RoundRow[], rowsP0: RoundRow[]) {
  const out: Record<string, unknown> = {};
  for (const k of KEYS) {
    let both = 0;
    let onlyP0 = 0;
    let onlyArm = 0;
    rowsX.forEach((rx, j) => {
      const r0 = rowsP0[j];
      const a = spinFin(rx) && rx.fp!.lk === k;
      const b = spinFin(r0) && r0.fp!.lk === k;
      if (a && b) both++;
      else if (b) onlyP0++;
      else if (a) onlyArm++;
    });
    const dist = (rows: RoundRow[]) => {
      const L = rows.filter((r) => spinFin(r) && r.fp!.lk === k);
      return { power: L.reduce<Record<string, number>>((a, r) => ((a[r.pow] = (a[r.pow] ?? 0) + 1), a), {}), matchup: L.reduce<Record<string, number>>((a, r) => ((a[`${r.p}-${r.r}`] = (a[`${r.p}-${r.r}`] ?? 0) + 1), a), {}) };
    };
    out[k] = { both, onlyP0, onlyArm, P0: dist(rowsP0), arm: dist(rowsX) };
  }
  return out;
}

// ───────────────────────────── P7c（§8.2） ─────────────────────────────

function p7c(set: SetName, rowsX: RoundRow[], rowsP0: RoundRow[], M: Methods) {
  const out: Record<string, unknown> = {};
  const sts: St[] = [];
  for (const k of KEYS) {
    const layers: { w0: number; w1: number }[][] = [];
    const ks = new Map<number, number>();
    rowsX.forEach((rx, j) => {
      if (rx.p === rx.r || (rx.p !== k && rx.r !== k)) return;
      const r0 = rowsP0[j];
      const side = rx.p === k ? 0 : 1;
      const w = (r: RoundRow) => (r.kind === 'win' && r.win === side ? 1 : 0);
      if (!ks.has(rx.h)) {
        ks.set(rx.h, layers.length);
        layers.push([]);
      }
      layers[ks.get(rx.h)!].push({ w0: w(r0), w1: w(rx) });
    });
    const rows = layers.flat();
    const n = rows.length;
    const win1 = rows.reduce((a, r) => a + r.w1, 0) / n;
    const win0 = rows.reduce((a, r) => a + r.w0, 0) / n;
    const dwin = win1 - win0;
    const [res] = stratBootstrap(layers, B, SEED, [{ name: 'Δwin', fn: (rs) => rs.reduce((a, r) => a + r.w1 - r.w0, 0) / rs.length }]);
    const bb = rows.filter((r) => r.w0 === 1 && r.w1 === 0).length;
    const cc = rows.filter((r) => r.w0 === 0 && r.w1 === 1).length;
    const decided = (rowsA: RoundRow[]) => {
      const g = rowsA.filter((r) => r.p !== r.r && (r.p === k || r.r === k) && r.kind === 'win');
      return g.length ? g.filter((r) => r.win === (r.p === k ? 0 : 1)).length / g.length : NaN;
    };
    const timeoutsNonMirror = rowsX.filter((r) => r.p !== r.r && (r.p === k || r.r === k) && r.cause === 'timeout').length;
    let st: St;
    const why: string[] = [];
    if (win1 < 0.1) {
      st = 'N';
      why.push(`胜率 ${win1} < 10%`);
    } else if (set === 'S1') {
      st = dwin >= -0.15 ? 'S' : 'N';
      if (st === 'N') why.push(`Δwin 点估计 ${dwin} < −0.15`);
    } else if (!M.Q5) {
      st = 'U';
      why.push('配对二元 bootstrap（Q5）未通过覆盖率验收');
    } else if (res.failed) {
      st = 'F';
      why.push(res.failed);
    } else {
      st = res.lo >= -0.15 ? 'S' : 'N';
      if (st === 'N') why.push(`Δwin 配对 CI 下限 ${res.lo} < −0.15`);
    }
    sts.push(st);
    out[k] = { status: st, why, rows: n, layers: layers.length, win: win1, winP0: win0, dwin, ci: M.Q5 ? [res.lo, res.hi] : null, ciReported: M.Q5, mcnemar: mcnemar(bb, cc), decidedWin: decided(rowsX), decidedWinP0: decided(rowsP0), timeoutsNonMirror };
  }
  return { status: worst(sts), perBuild: out };
}

// ───────────────────────────── P8（§8.2） ─────────────────────────────

function p8(set: SetName, x: AM) {
  const out: Record<string, unknown> = {};
  const sts: Record<string, St> = {};
  for (const k of KEYS) {
    const b = x.perBuild[k];
    const n = b.spinLosers;
    const share = b.E1a;
    const [wl] = wilson(b.destab, n);
    let st: St;
    if (set === 'S1') st = n >= 20 ? (share >= 0.7 ? 'S' : 'N') : 'U';
    else st = n >= 40 ? (share >= 0.7 && wl >= 0.55 ? 'S' : 'N') : 'U';
    sts[k] = st;
    out[k] = { status: st, n, destab: b.destab, share, wilsonLower: wl, note: st === 'U' ? `可测量样本 n = ${n}（< ${set === 'S1' ? 20 : 40}）` : '' };
  }
  return { status: worst(Object.values(sts)), perBuild: out, satisfied: Object.values(sts).filter((s) => s === 'S').length };
}

// ───────────────────────────── 描述性：M2 / M3 / M4 每构筑的分层成组 bootstrap ─────────────────────────────

function perBuildCIs(rows: RoundRow[], set: SetName, M: Methods) {
  const seeds = set === 'S1' ? 20 : 40;
  const layers: RoundRow[][] = Array.from({ length: 16 }, () => []);
  for (const r of rows) layers[r.h].push(r);
  const stats: BootStat<RoundRow>[] = [];
  for (const k of KEYS) {
    const pick = (rs: RoundRow[], f: (r: RoundRow) => number | null) => rs.map(f).filter((v): v is number => v !== null);
    stats.push({ name: `M2 ${k}`, fn: (rs) => {
      const v = pick(rs, (r) => (spinFin(r) && r.fp!.lk === k ? r.fp!.onset : null));
      return v.length ? median(v) : { empty: [{ group: k, arm: 'arm' }] };
    } });
    stats.push({ name: `M3 ${k}`, fn: (rs) => {
      const v = pick(rs, (r) => (spinFin(r) && r.fp!.lk === k && r.fp!.destab ? r.fp!.D : null));
      return v.length ? median(v) : { empty: [{ group: k, arm: 'arm' }] };
    } });
    for (const [bn, lo, hi] of [['hi', 0.6, 2], ['mid', 0.3, 0.6], ['lo', 0, 0.3]] as const)
      stats.push({ name: `M4 ${k} ${bn}`, fn: (rs) => {
        const v = rs.flatMap((r) => r.kn.filter((x) => (x[0] === 0 ? r.p : r.r) === k && x[1] >= lo && x[1] < hi && x[3] === 0).map((x) => x[2]));
        return v.length ? median(v) : { empty: [{ group: `${k}|${bn}`, arm: 'arm' }] };
      } });
  }
  if (layers.some((l) => l.length !== seeds)) throw new Error('层的行数与集合不符');
  return stratBootstrap(layers, B, SEED, stats).map((r) => ({ name: r.name, point: r.point, lo: M.Q1 && M.Q2 ? r.lo : null, hi: M.Q1 && M.Q2 ? r.hi : null, valid: r.valid, degenerate: r.degenerate, unstable: r.unstable, failed: r.failed }));
}

function soloReport(solo: SoloRow[], s3: S3Row[]) {
  const sig = solo.filter((r) => KEYS.includes(r.name));
  const by = (k: string) => sig.filter((r) => r.name === k);
  const nums = (xs: (number | null)[]) => xs.filter((v): v is number => typeof v === 'number');
  const S2 = Object.fromEntries(
    [...KEYS, ...[...new Set(solo.map((r) => r.name))].filter((n) => !KEYS.includes(n))].map((k) => {
      const g = solo.filter((r) => r.name === k);
      const ends = g.reduce<Record<string, number>>((a, r) => ((a[r.end] = (a[r.end] ?? 0) + 1), a), {});
      const top = g.filter((r) => r.end === 'topple');
      return [k, { runs: g.length, ends, toppleShare: g.length ? top.length / g.length : null, toppleWilson: wilson(top.length, g.length), toppleSpinP50: median(top.map((r) => r.endSpin)), endAtP50: median(g.map((r) => r.endAt)), destabShare: g.filter((r) => r.destabDuration !== null).length / g.length, destabDurationP50: median(nums(g.map((r) => r.destabDuration))), destabOnsetRatioP50: median(nums(g.map((r) => r.destabOnsetRatio))), wpdP50: median(g.map((r) => r.wpd)) }];
    }),
  );
  const onset = (ks: string[]) => median(nums(ks.flatMap((k) => by(k).map((r) => r.destabOnsetRatio))));
  const S3 = Object.fromEntries(
    KEYS.map((k) => [
      k,
      Object.fromEntries(
        [0.9, 0.6, 0.4, 0.25].map((ratio) => {
          const g = s3.filter((r) => r.key === k && r.ratio === ratio);
          const reached = g.filter((r) => r.reached);
          const done = reached.filter((r) => !r.censored);
          const fell = reached.filter((r) => r.fell).length;
          const unrec = reached.filter((r) => r.censored).length;
          return [ratio, { n: g.length, reached: reached.length, peakP50: median(reached.map((r) => r.peak as number)), recoverP50: median(done.map((r) => r.recover as number)), unrecovered: unrec, unrecoveredWilson: wilson(unrec, reached.length), fell, fellWilson: wilson(fell, reached.length), bShareP50: median(reached.map((r) => r.bShare as number)) }];
        }),
      ),
    ]),
  );
  return { S2, deltaS2: onset(['lieren', 'senheng']) - onset(['pandun', 'ziyao']), S3, s3PeakMedianAll: median(s3.filter((r) => r.reached).map((r) => r.peak as number)) };
}

// ───────────────────────────── 主流程 ─────────────────────────────

test('C2-P 判定', () => {
  const set = (process.env.C2P_SET ?? 'S1') as SetName;
  const file = `c2p-analysis-${set}.jsonl`;
  const M = methods();
  emit(file, 'C2P-AN-METHODS', { complete: M.complete, Q1: M.Q1, Q2: M.Q2, Q3: M.Q3, Q4: M.Q4, Q5: M.Q5, smallSampleRule: M.smallSampleRule, fails: M.fails, cases: M.rows.map((r) => ({ c: r.c, q: r.q, role: r.role, C_cons: r.C_cons, C_valid: r.C_valid, D_ds: r.D_ds, D_rs: r.D_rs, covered: r.covered, nondegenerate: r.nondegenerate, sha256: r.sha256 })) });
  const timing = existsSync('test-results/c2p-timing.jsonl') ? readFileSync('test-results/c2p-timing.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const arms: ArmName[] = set === 'S1' ? ['P0', 'Pa', 'Pb', 'Pc'] : ['P0', process.env.C2P_ARM as ArmName];
  const data = Object.fromEntries(arms.map((a) => [a, load(set, a)])) as Record<ArmName, ArmData | null>;
  const missing = arms.filter((a) => !data[a] || !data[a]!.sum);
  if (missing.length) throw new Error(`缺少实验臂输出：${missing.join(', ')}`);
  const met = Object.fromEntries(arms.map((a) => [a, armMetrics(data[a]!)])) as Record<ArmName, AM>;
  const P0 = data.P0!;
  for (const a of arms) {
    const d = data[a]!;
    emit(file, 'C2P-AN-ARM', { set, arm: a, budget: ARMS[a], metrics: met[a], audit: d.sum.audit, determinism: d.sum.determinism, checks: d.sum.checks, perBuildCI: perBuildCIs(d.rows, set, M), solo: soloReport(d.solo, d.s3) });
  }
  const results: Record<string, { status: St; conds: Record<string, unknown>; p8: ReturnType<typeof p8>; E1b: number }> = {};
  for (const a of arms.filter((x) => x !== 'P0')) {
    const x = met[a];
    const d = data[a]!;
    const c: Record<string, { status: St; value?: unknown; why?: string }> = {};
    c['P1 E1a'] = { status: ge(x.E1a, 0.8, 0.03, set), value: x.E1a };
    c['P1 E1b'] = { status: inRange(x.E1b, 1, 4, 0.2, set), value: x.E1b };
    c['P1 E1c'] = { status: ge(x.E1c, 0.7, 0.03, set), value: x.E1c };
    c['P1 E1d'] = { status: ge(x.E1d, 0.9, 0.03, set), value: x.E1d };
    c['P2 E4'] = { status: ge(x.E4, 1.3, 0.1, set), value: x.E4 };
    c['P3 E5'] = { status: ge(x.E5, 0.99, 0.03, set), value: x.E5 };
    const P4 = p4(set, d.rows, P0.rows, M);
    c['P4'] = { status: P4.status, value: P4.delta.point, why: P4.reasons.join('；') };
    const ownOk = x.own <= met.P0.own + 0.03;
    c['P6 自灭'] = { status: ownOk ? 'S' : 'N', value: [x.own, met.P0.own] };
    c['P6 时长中位'] = { status: Number.isNaN(x.durMed) ? 'U' : x.durMed >= 8 && x.durMed <= 35 ? 'S' : 'N', value: x.durMed };
    c['P6 打满 60 s'] = { status: x.atLimit <= 0.15 ? 'S' : 'N', value: x.atLimit };
    c['P6 账本残差'] = { status: d.sum.audit.ledgerResidualMax <= 0.01 ? 'S' : 'N', value: d.sum.audit.ledgerResidualMax };
    c['P6 NaN / 穿地'] = { status: d.sum.audit.badSteps === 0 && d.sum.audit.badRounds === 0 ? 'S' : 'N', value: [d.sum.audit.badSteps, d.sum.audit.badRounds] };
    c['P6 确定性'] = { status: d.sum.determinism.identical ? 'S' : 'N', value: d.sum.determinism };
    c['P6 开局速度比'] = { status: Number.isNaN(x.opening) ? 'U' : x.opening >= 1.5 ? 'S' : 'N', value: x.opening };
    c['P7a 爆裂占比'] = { status: inRange(x.burstShare, 0.15, 0.25, 0.02, set), value: x.burstShare };
    c['P7b 时长中位'] = { status: inRange(x.durMed, 12, 18, 1, set), value: x.durMed };
    const P7c = p7c(set, d.rows, P0.rows, M);
    c['P7c'] = { status: P7c.status, value: P7c.perBuild };
    const P8 = p8(set, x);
    for (const k of KEYS) c[`P8 ${k}`] = { status: (P8.perBuild[k] as { status: St }).status, value: P8.perBuild[k] };
    c['P9 范围'] = { status: 'S', why: '代码审查：只有 stepPosture 的刚度项乘 λ；关闭时与 kRef = ∞ 时 golden 180 场逐场一致（单元测试）' };
    const measErr = d.sum.checks.finishMismatch + d.sum.checks.knockMismatch + d.sum.checks.probeMismatch;
    const status = worst(Object.values(c).map((v) => v.status));
    results[a] = { status, conds: c, p8: P8, E1b: x.E1b };
    const chi = chiSquare2xK(met.P0.finishVector, x.finishVector);
    emit(file, 'C2P-AN-COND', { set, arm: a, kRef: ARMS[a].kRef, statuses: Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v.status])), conds: c, P4, P4composition: composition(d.rows, P0.rows), P4bothSpinLosers: p4(set, d.rows, P0.rows, M, (rx, r0) => spinFin(rx) && spinFin(r0) && rx.fp!.lk === r0.fp!.lk && rx.lose === r0.lose), P7d: { P0: met.P0.finishVector, arm: x.finishVector, ...chi, note: '同种子配对，卡方独立性假设不成立，只报告' }, measurementChecks: d.sum.checks, measurementError: measErr > 0, timing: timing.find((t) => t.arm === a) ?? null });
  }
  if (set === 'S1') {
    const cands = Object.entries(results).filter(([, r]) => r.status !== 'N' && r.status !== 'F').map(([a]) => a as ArmName);
    const anyF = Object.values(results).some((r) => r.status === 'F');
    const p1ok = Object.entries(results).filter(([, r]) => ['P1 E1a', 'P1 E1b', 'P1 E1c', 'P1 E1d'].every((k) => (r.conds[k] as { status: St }).status === 'S')).map(([a]) => a);
    const p7viol = Object.entries(results).filter(([, r]) => ['P7a 爆裂占比', 'P7b 时长中位', 'P7c'].some((k) => (r.conds[k] as { status: St }).status === 'N')).map(([a]) => a);
    const sorted = [...cands].sort((a, b) => results[b].p8.satisfied - results[a].p8.satisfied || Math.abs(results[a].E1b - 2) - Math.abs(results[b].E1b - 2) || ARMS[b].kRef - ARMS[a].kRef);
    emit(file, 'C2P-AN-SCREEN', {
      set,
      perArm: Object.fromEntries(Object.entries(results).map(([a, r]) => [a, { screening: r.status === 'N' ? '筛选失败' : r.status === 'F' ? '统计分析失败（待重算）' : '进入 S4 候选', worst: r.status, failed: Object.entries(r.conds).filter(([, v]) => (v as { status: St }).status === 'N').map(([k]) => k), uncertain: Object.entries(r.conds).filter(([, v]) => (v as { status: St }).status === 'U').map(([k]) => k), p8Satisfied: r.p8.satisfied, E1b: r.E1b }])),
      candidates: cands,
      selected: anyF ? null : sorted[0] ?? null,
      selectionOrder: sorted,
      stop1_noArmMeetsP1: p1ok.length === 0,
      armsMeetingP1: p1ok,
      stop5_allViolateP7: p7viol.length === 3,
      armsViolatingP7: p7viol,
      stop3_timing: timing.filter((t) => t.stop3).map((t) => t.arm),
    });
  } else {
    const a = arms[1];
    const r = results[a];
    emit(file, 'C2P-AN-FINAL', { set, arm: a, result: r.status === 'S' ? '通过' : r.status === 'U' ? '有条件结果' : r.status === 'N' ? '失败' : '统计分析失败（不给出最终结果）', uncertain: Object.entries(r.conds).filter(([, v]) => (v as { status: St }).status === 'U').map(([k, v]) => `${k}：${(v as { why?: string }).why ?? ''}`), failed: Object.entries(r.conds).filter(([, v]) => (v as { status: St }).status === 'N').map(([k]) => k) });
  }
}, 3600000);
