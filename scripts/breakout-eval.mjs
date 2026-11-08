/**
 * 第三轮：低速接触与脱困 A/B 对照表。读取 tests/diag/breakoutprobe.diag.ts 的输出。
 *   node scripts/breakout-eval.mjs test-results/motion/bp-A.json test-results/motion/bp-B.json [--set main|long|extra] [--json out.json]
 * main = 主矩阵 106 场（AvD/DvA/SvA/BvB/AvA/DFLT/POWER），long = LONG 6 场，extra = WALL/AIM/PHASE。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const files = args.filter((a) => a.endsWith('.json') && !a.startsWith('--'));
const setArg = args.includes('--set') ? args[args.indexOf('--set') + 1] : 'main';
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const SETS = { main: ['AvD', 'DvA', 'SvA', 'BvB', 'AvA', 'DFLT', 'POWER'], long: ['LONG'], extra: ['WALL', 'AIM', 'PHASE'] };
const keys = SETS[setArg];

const q = (a, p) => {
  const s = a.filter(Number.isFinite).sort((x, y) => x - y);
  if (!s.length) return NaN;
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const med = (a) => q(a, 0.5);
const mean = (a) => {
  const s = a.filter(Number.isFinite);
  return s.length ? s.reduce((x, y) => x + y, 0) / s.length : NaN;
};
const f = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const pct = (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(0)}%` : '—');

function evalFile(path) {
  const d = JSON.parse(readFileSync(path, 'utf8'));
  const runs = keys.flatMap((k) => (d.groups[k] ?? []).map((r) => ({ ...r, group: k })));
  const trigs = runs.flatMap((r) => r.trigs.map((t) => ({ ...t, run: r.name })));
  const st = trigs.filter((t) => t.kind === 'stall');
  const wb = trigs.filter((t) => t.kind === 'wobble');
  const segs = runs.flatMap((r) => r.segs.map((s) => ({ ...s, dur: s.t1 - s.t0, run: r.name })));
  const durs = segs.map((s) => s.dur);
  // 自然漂开后的再接触：每个 natural 结束的段，到同场下一段开始的间隔
  const reGaps = [];
  let natural = 0;
  for (const r of runs) {
    for (let i = 0; i < r.segs.length; i++) {
      const s = r.segs[i];
      if (s.end !== 'natural') continue;
      natural++;
      const n = r.segs[i + 1];
      reGaps.push(n ? n.t0 - s.t1 : Infinity);
    }
  }
  const finite = reGaps.filter(Number.isFinite);
  const results = runs.map((r) => r.result.split(':')[1] ?? 'timeout');
  const cnt = (k) => results.filter((x) => x === k).length;
  const after = (k) => trigs.filter((t) => t.after[k]);
  const touchAfter = (k) => (after(k).length ? after(k).filter((t) => t.after[k].touching).length / after(k).length : NaN);
  const winsBy = {};
  for (const r of runs) {
    winsBy[r.group] ??= { player: 0, rival: 0, none: 0 };
    winsBy[r.group][r.result.split(':')[0] === 'timeout' ? 'none' : r.result.split(':')[0]]++;
  }
  const T = runs.reduce((s, r) => s + r.duration, 0);
  const row = {
    file: path,
    场次: runs.length,
    '通用僵持触发': st.length,
    'death wobble 触发': wb.length,
    '有通用僵持的场次': runs.filter((r) => r.trigs.some((t) => t.kind === 'stall')).length,
    '有 wobble 的场次': runs.filter((r) => r.trigs.some((t) => t.kind === 'wobble')).length,
    '通用僵持：触发时未接触': st.length ? `${st.filter((t) => !t.touching).length}/${st.length}` : '0/0',
    '全部触发：触发时未接触': trigs.length ? `${trigs.filter((t) => !t.touching).length}/${trigs.length}` : '0/0',
    '触发后 0.5s 仍接触': pct(touchAfter(0.5)),
    '触发后 0.5s 中位中心距': f(med(after(0.5).map((t) => t.after[0.5].d))),
    '触发后 1.0s 中位中心距': f(med(after(1).map((t) => t.after[1].d))),
    '触发后再接触中位(s)': f(med(trigs.map((t) => t.reT).filter((x) => x !== null))),
    '触发后到终局未再接触': trigs.length ? pct(trigs.filter((t) => t.reT === null).length / trigs.length) : '—',
    '触发后 0.7s 内速度增量中位 / 最大 (m/s)': `${f(med(trigs.map((t) => t.dvAfter)))} / ${f(Math.max(0, ...trigs.map((t) => t.dvAfter)))}`,
    接触段数: segs.length,
    '接触段/10s': f((segs.length / T) * 10),
    '接触时长 中位 / P90 / 最大 (s)': `${f(med(durs))} / ${f(q(durs, 0.9))} / ${f(Math.max(0, ...durs))}`,
    '>1s 接触段': durs.filter((x) => x > 1).length,
    '>2.5s 接触段': durs.filter((x) => x > 2.5).length,
    '接触总时长占比': pct(durs.reduce((s, x) => s + x, 0) / T),
    '死亡阶段接触 中位 / 均值': `${pct(med(runs.map((r) => r.death)))} / ${pct(mean(runs.map((r) => r.death)))}`,
    '死亡阶段时长中位(s)': f(med(runs.map((r) => r.deathDur))),
    '自然漂开段数': natural,
    '漂开后再接触比例': natural ? pct(finite.length / natural) : '—',
    '漂开后 1s 内再接触': natural ? pct(finite.filter((x) => x <= 1).length / natural) : '—',
    '漂开后再接触间隔 中位 / P90 (s)': `${f(med(finite))} / ${f(q(finite, 0.9))}`,
    '低速静止(双方<0.2m/s) 最长 / 占比': `${f(Math.max(0, ...runs.map((r) => r.stillLong)))}s / ${pct(runs.reduce((s, r) => s + r.stillTot, 0) / T)}`,
    'feelSim 口径僵持 最长 / 占比': `${f(Math.max(0, ...runs.map((r) => r.stallLong)))}s / ${pct(runs.reduce((s, r) => s + r.stallTot, 0) / T)}`,
    平均时长: f(T / runs.length),
    '最长对局(s)': f(Math.max(...runs.map((r) => r.duration))),
    '结束 spin/over/xtreme/burst/timeout': ['spin', 'over', 'xtreme', 'burst', 'timeout'].map(cnt).join('/'),
    '120s 强制判定': runs.filter((r) => r.forced120).length,
    '最大半径(m)': f(Math.max(...runs.map((r) => r.maxR))),
    '逐步最大位移(m)': f(Math.max(...runs.map((r) => r.maxStep)), 3),
    '离墙离对手时逐步最大速度变化(m/s)': f(Math.max(...runs.map((r) => r.maxDvFree)), 3),
    '中强撞/10s': f((runs.reduce((s, r) => s + r.strong, 0) / T) * 10),
    '输家终局倾斜>1rad（侧翻）': `${runs.filter((r) => (r.loserTiltEnd ?? 0) > 1).length}/${runs.filter((r) => r.loserTiltEnd !== null).length}`,
    '胜负（玩家/对手）按组': Object.entries(winsBy)
      .map(([k, v]) => `${k} ${v.player}/${v.rival}${v.none ? `/超时${v.none}` : ''}`)
      .join('；'),
  };
  return { row, runs, trigs, segs };
}

const evals = files.map(evalFile);
const cols = Object.keys(evals[0].row).filter((k) => k !== 'file');
console.log(`集合：${setArg}（${keys.join('/')}）\n`);
console.log(`| 指标 | ${evals.map((e) => e.row.file.replace(/^.*bp-|\.json$/g, '')).join(' | ')} |`);
console.log(`|---|${evals.map(() => '---').join('|')}|`);
for (const k of cols) console.log(`| ${k} | ${evals.map((e) => e.row[k]).join(' | ')} |`);
// 逐场差异（前两份文件）
if (evals.length >= 2) {
  const [a, b] = evals;
  const diff = [];
  for (const ra of a.runs) {
    const rb = b.runs.find((x) => x.name === ra.name);
    if (!rb) continue;
    if (ra.result !== rb.result || Math.abs(ra.duration - rb.duration) > 0.005) diff.push(`${ra.name}: ${ra.result} ${ra.duration.toFixed(2)}s → ${rb.result} ${rb.duration.toFixed(2)}s`);
  }
  console.log(`\n逐场变化（结果或时长不同）：${diff.length}/${a.runs.length}`);
  for (const l of diff) console.log(`- ${l}`);
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(evals.map((e) => e.row), null, 1));
