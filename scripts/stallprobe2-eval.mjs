// 低速停滞探针 V2：汇总分析（只读原始数据，不改任何东西）。
//   node scripts/stallprobe2-eval.mjs <数据根目录> > eval.md
// 数据根目录下应有 B/ A/ R1a/ R1b/ 各自的 runs.all.json（缺的配置跳过）。
// 所有阈值都只用于组织数据，写在每节开头；原始字段在 runs.all.json / track / series 里。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] ?? 'test-results/stallprobe2';
const load = (c) => {
  const f = join(root, c, 'runs.all.json');
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
};
const D = { B: load('B'), A: load('A'), R1a: load('R1a'), R1b: load('R1b') };
const out = [];
const P = (...a) => out.push(a.join(''));
const fx = (x, d = 2) => (x === null || x === undefined || Number.isNaN(x) ? '–' : typeof x === 'number' ? (Number.isFinite(x) ? x.toFixed(d) : String(x)) : String(x));
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : '–');
function q(arr, p) {
  const a = arr.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return NaN;
  return a[Math.min(a.length - 1, Math.max(0, Math.ceil(p * a.length) - 1))];
}
const dist = (arr, d = 2) => {
  const a = arr.filter((x) => Number.isFinite(x));
  return a.length ? `n=${a.length} P50 ${fx(q(a, 0.5), d)} / P90 ${fx(q(a, 0.9), d)} / max ${fx(Math.max(...a), d)}` : 'n=0';
};
const T = (head, rows) => {
  P('| ', head.join(' | '), ' |');
  P('|', head.map(() => '---').join('|'), '|');
  for (const r of rows) P('| ', r.join(' | '), ' |');
  P('');
};
const SHORT = { 'needle-point': '针尖', 'dome-ball': '球头', 'rush-rubber': '橡胶', 'gear-flat': '齿平' };
const combo = (r) => r.tips.map((t) => SHORT[t] ?? t).sort().join('/');

// 场景类别（用户矩阵 1–4：按陀尖与功率给整场归类）
function runCat(r) {
  const [a, b] = r.tips;
  const nn = a === 'needle-point' && b === 'needle-point';
  if (r.group === 'CTRL') return `CTRL-${r.name.split(' ')[1]}`;
  if (nn) return r.group === 'NNPOW' && !r.name.startsWith('NNPOW 0.9') ? '2 针尖对针尖·低功率' : '1 针尖对针尖·正常功率';
  if (a === 'dome-ball' && b === 'dome-ball') return '3 球头对球头';
  if ((a === 'needle-point' && b === 'rush-rubber') || (b === 'needle-point' && a === 'rush-rubber')) return '4 针尖对橡胶';
  return '其他组合';
}
// 段位置：两台进入时半径（中央平台 r<0.6；陡坡 r≥3.6；轨道/墙 r≥4.75）
function loc(e) {
  const m = Math.max(...e.r0);
  const n = Math.min(...e.r0);
  if (m >= 4.75) return '墙边(≥4.75)';
  if (m >= 3.6) return '外圈陡坡(3.6–4.75)';
  if (m < 0.6 && n < 0.6) return '碗底(双方<0.6)';
  return '中段';
}
const domIntent = (e, side) => {
  let best = '';
  let n = -1;
  for (const [k, v] of Object.entries(e.intents)) if (k.startsWith(side + ':') && v > n) [best, n] = [k.slice(2), v];
  return best;
};
const TST = ['applied', 'gripLow', 'inelig', 'edgeBlock', 'cap', 'other'];
const frac = (ts, k) => {
  const s = ts.reduce((x, y) => x + y, 0);
  return s ? ts[TST.indexOf(k)] / s : NaN;
};
// DEADLOCK 形态（数据组织用）：进入后 3 s 时仍在 WATCH，且双方累计路径都 < 0.5 m
const isPos = (e) => e.ck.length >= 3 && Math.max(...e.ck[2].path) < 0.5;
// 牵引有效性四类（每台，WATCH(0.4) 段且持续 ≥ 1 s；看第 1 s 窗口）：
//  1 无牵引：第 1 s 内牵引施加比例 < 5%
//  2 有牵引但运动不足：施加 ≥ 5% 且第 1 s 累计路径 < 0.15 m
//  3 有运动但没有接近：路径 ≥ 0.15 m，段不是以接触结束
//  4 有效运动并恢复接触：路径 ≥ 0.15 m（或施加 ≥ 5%），段以接触结束
function tclass(e, i) {
  const c = e.ck[0];
  const ap = frac(c.ts[i], 'applied');
  const path = c.path[i];
  if (ap < 0.05 && path < 0.15) return e.end === 'contact' ? '0 无牵引但被对方带到接触' : '1 无牵引';
  if (path < 0.15) return e.end === 'contact' ? '2b 有牵引运动不足·仍接触' : '2 有牵引但运动不足';
  return e.end === 'contact' ? '4 有效运动并恢复接触' : '3 有运动但没有接近';
}

const B = D.B;
P('# 低速停滞探针 V2 汇总（由 scripts/stallprobe2-eval.mjs 生成）');
P('');
P(`配置：${Object.entries(D).filter(([, v]) => v).map(([k, v]) => `${k}（${v.runs.length} 场${v.tune ? `，DIAG_TUNE ${v.tune}` : ''}${v.r1 ? `，R1=${v.r1}` : ''}）`).join('、')}`);
P('');
const meta = B.runs[0].meta;
P(`Rapier 参数（实测读取）：predictionDistance ${meta.predictionDistance}（normalized ${meta.normalizedPredictionDistance} × lengthUnit ${meta.lengthUnit}），allowedLinearError ${meta.allowedLinearError}，solver 迭代 ${meta.numSolverIterations}，contactSkin 全部 ${[...new Set(B.runs.flatMap((r) => r.meta.contactSkin.flat()))].join('/')}。`);
P('');

// ── 0. 场景矩阵 ──
P('## 0. 场景矩阵与有效样本');
P('');
{
  const g = {};
  for (const r of B.runs) {
    const k = r.group;
    (g[k] ??= []).push(r);
  }
  T(
    ['分组', '场次', '种子', '陀尖组合', '初始条件（首场）', '上限 s', 'WATCH(0.4) 段', '≥1 s', '≥3 s', 'DEADLOCK 形态'],
    Object.entries(g).map(([k, rs]) => {
      const eps = rs.flatMap((r) => r.watch[1].eps);
      return [k, rs.length, `${Math.min(...rs.map((r) => r.seed))}–${Math.max(...rs.map((r) => r.seed))}`, [...new Set(rs.map(combo))].join('、'), rs[0].init, rs[0].maxSeconds, eps.length, eps.filter((e) => e.dur >= 1).length, eps.filter((e) => e.dur >= 3).length, eps.filter(isPos).length];
    }),
  );
  const c = {};
  for (const r of B.runs) (c[runCat(r)] ??= []).push(r);
  P('按用户矩阵 1–4 归类（整场）：');
  P('');
  T(
    ['类别', '场次', '结果分布', '时长 P50/P90/max', 'WATCH(0.4) 段', 'DEADLOCK 形态段', '含形态段的场次'],
    Object.entries(c)
      .sort()
      .map(([k, rs]) => {
        const res = {};
        for (const r of rs) {
          const f = r.result.split(':')[1] ?? r.result;
          res[f] = (res[f] ?? 0) + 1;
        }
        const eps = rs.flatMap((r) => r.watch[1].eps);
        return [k, rs.length, Object.entries(res).map(([a, b]) => `${a} ${b}`).join(' '), `${fx(q(rs.map((r) => r.duration), 0.5), 1)} / ${fx(q(rs.map((r) => r.duration), 0.9), 1)} / ${fx(Math.max(...rs.map((r) => r.duration)), 1)}`, eps.length, eps.filter(isPos).length, rs.filter((r) => r.watch[1].eps.some(isPos)).length];
      }),
  );
}

// ── 1. 接触证据 ──
P('## 1. 接触证据：真实接触 / 预测接近 / 几何贴近 / 无证据（逐步）');
P('');
P('划分：real = 求解器接触点距离 ≤ 0 或有正法向冲量；predict = 有 manifold / 求解器接触点但距离 > 0 且无正冲量；geom = 没有接触点但三维形状距离 ≤ 1 cm 或 XZ 刀刃投影重叠；none = 都没有。');
P('');
for (const [cfg, d] of Object.entries(D)) {
  if (!d) continue;
  const S = (f) => d.runs.reduce((x, r) => x + f(r.tally), 0);
  const steps = S((t) => t.steps);
  P(`**${cfg}**（${steps} 步）：none ${S((t) => t.cls[0])}（${pct(S((t) => t.cls[0]), steps)}）· geom ${S((t) => t.cls[1])}（XZ 重叠 ${S((t) => t.geomOverlapXZ)} / 仅三维 ≤1 cm ${S((t) => t.geomDist3d)}）· predict ${S((t) => t.cls[2])}（有求解器点 ${S((t) => t.predictSolver)} / 仅 manifold 点 ${S((t) => t.predictManifoldOnly)}）· real ${S((t) => t.cls[3])}（穿透且正冲量 ${S((t) => t.realPen)} / 穿透无冲量 ${S((t) => t.realPenNoImp)} / 仅正冲量未穿透 ${S((t) => t.realImpOnly)}）。V1「confirmed」（求解器点且正冲量）${S((t) => t.v1Confirmed)} 步。旧口径「接触」（XZ 中心距 < 刀刃和 + 5 cm）${S((t) => t.oldTouch)} 步，其中 real ${S((t) => t.oldTouchReal)}（${pct(S((t) => t.oldTouchReal), S((t) => t.oldTouch))}）。`);
  P('');
}
{
  const pairs = {};
  for (const r of B.runs) for (const [k, v] of Object.entries(r.tally.pairs)) (pairs[k] ??= [0, 0, 0]).forEach((_, i, a) => (a[i] += v[i]));
  P('B 按碰撞体对（逐步计数；同一步可有多对）：');
  P('');
  T(['碰撞体对', '仅三维 ≤1 cm', 'predict', 'real'], Object.entries(pairs).sort((a, b) => b[1][2] - a[1][2]).map(([k, v]) => [k, ...v]));
  const c = {};
  for (const r of B.runs) {
    const k = combo(r);
    const e = (c[k] ??= [0, 0, 0, 0, 0]);
    r.tally.cls.forEach((v, i) => (e[i] += v));
    e[4] += r.tally.steps;
  }
  P('B 按陀尖组合：');
  P('');
  T(['组合', '步数', 'none', 'geom', 'predict', 'real'], Object.entries(c).map(([k, v]) => [k, v[4], pct(v[0], v[4]), pct(v[1], v[4]), pct(v[2], v[4]), pct(v[3], v[4])]));
}

// ── 2. 接触段 ──
P('## 2. 接触段持续时间（秒）');
P('');
P('realH0 = 连续 real 步；realH6 = real 段允许中断 ≤ 6 步（50 ms）；anyH0 = 连续 real 或 predict 步。');
P('');
{
  const rows = [];
  const byC = {};
  for (const r of B.runs) for (const s of r.segs) ((byC[combo(r)] ??= {})[s.key] ??= []).push(...s.durs);
  for (const [k, v] of Object.entries(byC)) for (const key of ['realH0', 'realH6', 'anyH0']) rows.push([k, key, dist(v[key] ?? [], 3)]);
  const all = {};
  for (const r of B.runs) for (const s of r.segs) (all[s.key] ??= []).push(...s.durs);
  for (const key of ['realH0', 'realH6', 'anyH0']) rows.push(['全部', key, dist(all[key], 3)]);
  T(['组合', '口径', '段时长'], rows);
  const flaps = {};
  for (const r of B.runs) for (const s of r.segs) flaps[s.key] = (flaps[s.key] ?? 0) + s.flaps;
  P(`抖动（段结束后 0.25 s 内又进入）：${Object.entries(flaps).map(([k, v]) => `${k} ${v}`).join('，')}。`);
  P('');
  const long = [];
  for (const r of B.runs) {
    const s = r.segs.find((x) => x.key === 'realH6');
    s.durs.forEach((d, i) => d >= 0.3 && long.push([r.name, combo(r), fx(d, 3), fx(s.imps[i], 3), fx(s.imps[i] / d, 2)]));
  }
  P(`持续轻擦候选（realH6 段 ≥ 0.3 s，全部列出，${long.length} 段）：`);
  P('');
  T(['场景', '组合', '时长 s', '段内法向冲量和 N·s', '平均法向力 N'], long.sort((a, b) => b[2] - a[2]));
}

// ── 3. 采样盲区 ──
P('## 3. BattleSystem.sampleContact() 提前返回盲区');
P('');
for (const [cfg, d] of Object.entries(D)) {
  if (!d) continue;
  const S = (f) => d.runs.reduce((x, r) => x + f(r.tally), 0);
  P(`**${cfg}**：提前返回 ${S((t) => t.sampleEarly)} 步（复算条件不一致 ${S((t) => t.sampleEarlyCalcMismatch)} 步）；其中有 manifold 点 ${S((t) => t.earlyWithManifold)}、有求解器点 ${S((t) => t.earlyWithSolver)}、real ${S((t) => t.earlyReal)}（漏采）。采样未提前返回但 real 且法向冲量 = 0（正式反馈记为不接触）${S((t) => t.sampledRealNoImpulse)} 步。反馈状态非 idle 但 none ${S((t) => t.cfBusyNone)} 步；反馈 idle 但 real ${S((t) => t.cfIdleReal)} 步。`);
  P('');
}
{
  const ev = B.runs.flatMap((r) => r.tally.earlyRealEvents.map((e) => ({ ...e, run: r.name, combo: combo(r) })));
  const segs = B.runs.flatMap((r) => r.tally.earlyRealSegs);
  const pairs = {};
  for (const r of B.runs) for (const [k, v] of Object.entries(r.tally.earlyRealPairs)) pairs[k] = (pairs[k] ?? 0) + v;
  const runs = B.runs.filter((r) => r.tally.earlyReal > 0);
  P(`B 漏采：${runs.length} 场有漏采；碰撞体对 ${Object.entries(pairs).map(([k, v]) => `${k} ${v}`).join('，')}；连续漏采段长度（步）${dist(segs, 0)}。`);
  P('');
  P(`漏采步：outerGap ${dist(ev.map((e) => e.outerGap), 3)} m；较大倾角 ${dist(ev.map((e) => Math.max(...e.tilt)), 3)} rad；较小倾角 ${dist(ev.map((e) => Math.min(...e.tilt)), 3)} rad；minSolverDist ${dist(ev.map((e) => e.minSolverDist), 4)}；法向冲量 ${dist(ev.map((e) => e.impulse), 3)}。`);
  P('');
  const byC = {};
  for (const e of ev) byC[e.combo] = (byC[e.combo] ?? 0) + 1;
  P(`按组合：${Object.entries(byC).map(([k, v]) => `${k} ${v}`).join('，')}。（每场最多记录 400 个事件）`);
  P('');
}

// ── 4. WATCH 净位移 / 路径 ──
P('## 4. WATCH(0.4) 时间窗：净位移与累计路径（米，每台一个样本）');
P('');
P('只统计持续到该时刻的段（段短于窗口的不计入该窗口），净位移 = 该时刻位置 − 进入位置，路径 = 进入后逐步位移和。');
P('');
{
  const eps = B.runs.flatMap((r) => r.watch[1].eps.map((e) => ({ ...e, combo: combo(r) })));
  const rows = [];
  for (const k of [0, 1, 2, 3, 4]) {
    const at = [1, 2, 3, 5, 10][k];
    const es = eps.filter((e) => e.ck.length > k);
    for (const cmb of [...new Set(es.map((e) => e.combo))].sort()) {
      const s = es.filter((e) => e.combo === cmb);
      const net = s.flatMap((e) => e.ck[k].net);
      const path = s.flatMap((e) => e.ck[k].path);
      const eff = s.flatMap((e) => e.ck[k].net.map((n, i) => (e.ck[k].path[i] > 1e-6 ? n / e.ck[k].path[i] : NaN)));
      rows.push([`${at} s`, cmb, s.length, dist(net, 3), dist(path, 3), fx(q(eff, 0.5), 2)]);
    }
  }
  T(['窗口', '组合', '段数', '净位移', '累计路径', '净/路径 P50'], rows);
}

// ── 5. 牵引有效性 ──
P('## 5. 牵引有效性与实际运动');
P('');
P('牵引状态（每台每步，按 BeyPhysics 判定顺序取第一道没过的条件）：applied 施加；gripLow 咬合 < driveMinGrip；inelig 未着地 / 冲刺 / 转速太低；edgeBlock 借来的墙边咬合方向不帮离墙被挡；cap 速度已达上限；other 其他。');
P('');
{
  const tm = {};
  for (const r of B.runs)
    for (const [k, v] of Object.entries(r.tm)) {
      const e = (tm[k] ??= { n: v.n.map(() => 0), closing: 0, stepSum: 0 });
      v.n.forEach((x, i) => (e.n[i] += x));
      e.closing += v.closing;
      e.stepSum += v.stepSum;
    }
  const tips = [...new Set(Object.keys(tm).map((k) => k.split('|')[0]))];
  for (const W of ['W', 'F']) {
    P(`${W === 'W' ? 'WATCH(0.4) 内' : 'WATCH(0.4) 外（双方转速 > 10）'}：各牵引状态的步数占比与速度分布（速度分箱上界 0.05/0.1/0.2/0.4/0.8/1.6/∞ m/s）`);
    P('');
    const rows = [];
    for (const tip of tips) {
      const tot = TST.reduce((x, s) => x + (tm[`${tip}|${s}|${W}`]?.n.reduce((a, b) => a + b, 0) ?? 0), 0);
      for (const s of TST) {
        const e = tm[`${tip}|${s}|${W}`];
        if (!e) continue;
        const n = e.n.reduce((a, b) => a + b, 0);
        rows.push([SHORT[tip] ?? tip, s, n, pct(n, tot), e.n.map((x) => pct(x, n)).join(' / '), fx((e.stepSum / n) * 120, 3)]);
      }
    }
    T(['陀尖', '牵引状态', '步数', '占比', '速度分箱占比', '平均速度 m/s'], rows);
  }
  const eps = B.runs.flatMap((r) => r.watch[1].eps.filter((e) => e.dur >= 1).map((e) => ({ ...e, run: r, combo: combo(r) })));
  const cls = {};
  for (const e of eps)
    for (const i of [0, 1]) {
      const tip = SHORT[e.run.tips[i]] ?? e.run.tips[i];
      const k = `${tip}|${tclass(e, i)}`;
      const c = (cls[k] ??= { n: 0, pos: 0, dur: [] });
      c.n++;
      if (isPos(e)) c.pos++;
      c.dur.push(e.dur);
    }
  P('四类牵引有效性（WATCH(0.4) 段 ≥ 1 s，每台一个样本，看进入后第 1 s；规则见脚本 tclass()）：');
  P('');
  T(['陀尖', '类别', '样本', '其中 DEADLOCK 形态', '段时长'], Object.entries(cls).sort().map(([k, v]) => [...k.split('|'), v.n, v.pos, dist(v.dur, 2)]));
}

// ── 6. 正负样本对照 + 转速比 ──
P('## 6. 正负样本对照（同一窗口比较，避免把持续时间差当成机制差）');
P('');
P('正样本 = DEADLOCK 形态（3 s 时仍在 WATCH 且双方路径 < 0.5 m）；负样本 = 其余持续 ≥ 1 s 的段。两组都只用进入后第 1 s 的数据。');
P('');
{
  const eps = B.runs.flatMap((r) => r.watch[1].eps.filter((e) => e.dur >= 1).map((e) => ({ ...e, run: r, combo: combo(r) })));
  const rows = [];
  for (const cmb of [...new Set(eps.map((e) => e.combo))].sort()) {
    for (const pos of [true, false]) {
      const s = eps.filter((e) => e.combo === cmb && isPos(e) === pos);
      if (!s.length) continue;
      rows.push([
        cmb,
        pos ? '正' : '负',
        s.length,
        dist(s.flatMap((e) => e.ck[0].ts.map((t) => frac(t, 'applied'))), 2),
        dist(s.flatMap((e) => e.ck[0].path), 3),
        dist(s.flatMap((e) => e.ck[0].meanSpeed), 3),
        dist(s.map((e) => e.ck[0].bladeGap), 3),
        dist(s.flatMap((e) => e.ratio0), 2),
        dist(s.map((e) => e.spinAoverB0), 2),
        dist(s.flatMap((e) => e.r0), 2),
      ]);
    }
  }
  T(['组合', '组', '段', '第 1 s 牵引施加比例', '第 1 s 路径', '第 1 s 平均速度', '1 s 时刀刃间隙', '进入时转速比例', '进入时转速比 A/B', '进入时半径'], rows);
  P('转速比例（进入时较低一台的 spin / launchSpin）分箱 → 成为 DEADLOCK 形态的比例（段 ≥ 1 s）：');
  P('');
  const bins = [0, 0.2, 0.4, 0.6, 0.8, 1.01];
  const rows2 = [];
  for (const cmb of [...new Set(eps.map((e) => e.combo))].sort())
    for (let i = 0; i < bins.length - 1; i++) {
      const s = eps.filter((e) => e.combo === cmb && Math.min(...e.ratio0) >= bins[i] && Math.min(...e.ratio0) < bins[i + 1]);
      if (s.length) rows2.push([cmb, `${bins[i]}–${Math.min(1, bins[i + 1])}`, s.length, s.filter(isPos).length, pct(s.filter(isPos).length, s.length)]);
    }
  T(['组合', '较低转速比例', '段', 'DEADLOCK 形态', '占比'], rows2);
}

// ── 7. 组合、位置、意图 ──
P('## 7. 陀尖组合 / 位置 / 意图');
P('');
{
  const eps = B.runs.flatMap((r) => r.watch[1].eps.map((e) => ({ ...e, run: r, combo: combo(r) })));
  const grp = (keyf) => {
    const g = {};
    for (const e of eps) (g[keyf(e)] ??= []).push(e);
    return Object.entries(g)
      .sort()
      .map(([k, s]) => {
        const ends = {};
        for (const e of s) ends[e.end] = (ends[e.end] ?? 0) + 1;
        return [k, s.length, dist(s.map((e) => e.dur), 2), s.filter((e) => e.dur >= 3).length, s.filter(isPos).length, Object.entries(ends).map(([a, b]) => `${a} ${b}`).join(' '), dist(s.flatMap((e) => e.ts.map((t) => frac(t, 'applied'))), 2)];
      });
  };
  const head = ['分组', '段', '时长 s', '≥3 s', 'DEADLOCK 形态', '结束原因', '牵引施加比例（每台）'];
  P('按陀尖组合：');
  P('');
  T(head, grp((e) => e.combo));
  P('按进入位置（两台进入时半径）：');
  P('');
  T(head, grp((e) => `${loc(e)} · ${e.combo}`));
  P('按场景类别：');
  P('');
  T(head, grp((e) => runCat(e.run)));
  P('按主导意图（段内占比最高的意图，A:B）：');
  P('');
  T(head, grp((e) => `${domIntent(e, 'a')}:${domIntent(e, 'b')} · ${e.combo}`));
  // 自然低速漂移：以速度结束（没接触）且路径 ≥ 0.5 m
  const drift = eps.filter((e) => e.end === 'speed' && Math.max(...e.path) >= 0.5);
  P(`自然低速漂移（以速度超过 0.4 结束、没接触、任一台路径 ≥ 0.5 m）：${drift.length} 段，时长 ${dist(drift.map((e) => e.dur), 2)}，路径 ${dist(drift.flatMap((e) => e.path), 2)}，净位移 ${dist(drift.flatMap((e) => e.net), 2)}。`);
  P('');
  const ctrl = B.runs.filter((r) => r.group === 'CTRL');
  P('受控摆放（CTRL，全部列出）：');
  P('');
  T(
    ['场景', '结果', '时长', '最长 WATCH(0.4) 段 s', '该段路径', '该段净位移', 'real 步', 'realH6 最长段 s', 'wobble'],
    ctrl.map((r) => {
      const l = r.watch[1].eps.reduce((a, e) => (!a || e.dur > a.dur ? e : a), null);
      return [r.name, r.result, fx(r.duration, 1), fx(l?.dur, 2), l ? l.path.map((x) => fx(x, 2)).join('/') : '–', l ? l.net.map((x) => fx(x, 2)).join('/') : '–', r.tally.cls[3], fx(Math.max(0, ...r.segs[1].durs), 3), r.wobbleBreaks];
    }),
  );
}

// ── 8. DEADLOCK 形态段全表 ──
P('## 8. 所有 DEADLOCK 形态段（B，全部列出）');
P('');
{
  const rows = [];
  for (const r of B.runs)
    for (const e of r.watch[1].eps.filter(isPos))
      rows.push([r.name, combo(r), fx(e.t0, 1), fx(e.dur, 1), e.end, e.ck.map((c) => `${c.at}s:${c.net.map((x) => fx(x, 2)).join('/')}|${c.path.map((x) => fx(x, 2)).join('/')}`).join(' '), e.spin0.map((x) => fx(x, 0)).join('/'), fx(e.spinAoverB0, 2), e.ts.map((t) => fx(frac(t, 'applied'), 2)).join('/'), e.ts.map((t) => fx(frac(t, 'gripLow'), 2)).join('/'), fx(e.gapMin, 3), e.cls.join('/'), e.r0.map((x) => fx(x, 2)).join('/')]);
  T(['场景', '组合', '进入 s', '时长 s', '结束', '各窗口 净位移|路径（A/B）', '进入转速', '转速比 A/B', '施加比例', 'gripLow 比例', '最小刀刃间隙', '步类 none/geom/pred/real', '进入半径'], rows);
}

// ── 9. wobble ──
P('## 9. wobble 触发现场');
P('');
for (const [cfg, d] of Object.entries(D)) {
  if (!d) continue;
  const tr = d.runs.flatMap((r) => r.trig.map((x) => ({ ...x, run: r.name, combo: combo(r), deathT0: r.deathT0, end: r.duration })));
  const wb = tr.filter((x) => x.kind === 'wobble');
  const st = tr.filter((x) => x.kind === 'stall');
  const ws = d.runs.reduce((a, r) => a.map((v, i) => v + r.tally.wobblingSteps[i]), [0, 0, 0, 0]);
  const cnt = (s, f) => {
    const c = {};
    for (const x of s) c[f(x)] = (c[f(x)] ?? 0) + 1;
    return Object.entries(c).map(([a, b]) => `${a} ${b}`).join('，');
  };
  P(`**${cfg}**：wobble 触发 ${wb.length} 次（步类 ${cnt(wb, (x) => x.cls)}；碰撞体对 ${cnt(wb, (x) => x.contact.pairsReal.join('+') || '无')}；旧口径贴靠 ${wb.filter((x) => x.contact.oldTouch).length}；触发时有 R1 生效 ${wb.filter((x) => x.r1On.some(Boolean)).length}；触发前低转速一台已在 breakout ${wb.filter((x) => x.breakout.some((v, i) => v > 0 && x.spinRatio[i] === Math.min(...x.spinRatio))).length}）。wobble 计时中的步按类：none ${ws[0]} / geom ${ws[1]} / predict ${ws[2]} / real ${ws[3]}。通用僵持触发 ${st.length} 次（步类 ${cnt(st, (x) => x.cls)}）。`);
  P('');
  if (cfg === 'B' || cfg === 'R1a' || cfg === 'R1b')
    T(
      ['场景', '组合', 't', '距终局 s', '步类', '刀刃间隙', '三维距离', '碰撞体对', '倾角 A/B', '倾角超出 A/B', '转速比例 A/B', '意图 A/B', 'breakout A/B', 'R1'],
      wb.map((x) => [x.run, x.combo, fx(x.t, 2), fx(x.end - x.t, 2), x.cls, fx(x.bladeGap, 3), fx(x.dist3d, 4), x.contact.pairsReal.join('+') || x.contact.pairsPredict.join('+') || '–', x.tilt.map((v) => fx(v, 2)).join('/'), x.tiltExcess.map((v) => fx(v, 2)).join('/'), x.spinRatio.map((v) => fx(v, 2)).join('/'), x.intent.join('/'), x.breakout.map((v) => fx(v, 2)).join('/'), x.r1On.map(Number).join('/')]),
    );
}

// ── 10. 恢复候选 ──
P('## 10. 恢复候选启动时的状态');
P('');
P('自然候选 = B 里 WATCH(0.4) 持续 0.6 s 的时刻（与 R1 相同触发点，但 B 不做任何干预）；R1 启动 = R1a / R1b 实际启动时刻。');
P('');
{
  const cands = B.runs.flatMap((r) => r.watch[1].eps.filter((e) => e.cand).map((e) => ({ ...e.cand, e, combo: combo(r), nn: r.tips.every((t) => t === 'needle-point') })));
  const rows = [];
  for (const cmb of [...new Set(cands.map((c) => c.combo))].sort()) {
    for (const pos of [true, false]) {
      const s = cands.filter((c) => c.combo === cmb && isPos(c.e) === pos);
      if (!s.length) continue;
      rows.push([cmb, pos ? 'DEADLOCK 形态' : '其他', s.length, dist(s.map((c) => c.dXZ), 3), dist(s.map((c) => c.bladeGap), 3), dist(s.map((c) => c.dist3d), 3), dist(s.flatMap((c) => c.speed), 3), dist(s.flatMap((c) => c.velVsOppDeg), 0), dist(s.flatMap((c) => c.tractionVsOppDeg), 0), dist(s.map((c) => c.spinAoverB), 2)]);
    }
  }
  T(['组合', '段类型', '候选', 'XZ 中心距', '刀刃间隙', '三维距离', '速度', '速度方向 vs 指向对手 °', '牵引方向 vs 指向对手 °', '转速比 A/B'], rows);
  for (const cfg of ['R1a', 'R1b']) {
    const d = D[cfg];
    if (!d) continue;
    const acts = d.runs.flatMap((r) => (r.r1?.acts ?? []).map((a) => ({ ...a, combo: combo(r) })));
    const gb = [-Infinity, 0.02, 0.05, 0.1, 0.2, Infinity];
    const rows3 = [];
    for (const cmb of [...new Set(acts.map((a) => a.combo))].sort())
      for (let i = 0; i < gb.length - 1; i++) {
        const s = acts.filter((a) => a.combo === cmb && a.start.bladeGap >= gb[i] && a.start.bladeGap < gb[i + 1]);
        if (!s.length) continue;
        rows3.push([cmb, `${gb[i]}–${gb[i + 1]}`, s.length, pct(s.filter((a) => a.moveT !== null).length, s.length), pct(s.filter((a) => a.reT !== null).length, s.length), dist(s.filter((a) => a.reT !== null).map((a) => a.reT), 2), dist(s.map((a) => a.start.dist3d), 3), dist(s.flatMap((a) => a.start.speed), 3), dist(s.flatMap((a) => a.start.tractionVsOppDeg), 0), dist(s.map((a) => a.maxR), 2)]);
      }
    P(`**${cfg}** 启动按刀刃间隙分箱（启动 ${acts.length} 次）：`);
    P('');
    T(['组合', '启动时刀刃间隙 m', '启动', '动起来', '重新接触', '重新接触用时 s', '三维距离', '启动速度', '牵引方向 vs 指向对手 °', '期间最大半径'], rows3);
  }
}
console.log(out.join('\n'));
