// Stage B：R1c A/B 对照汇总（只读原始数据）。
//   node scripts/r1c-eval.mjs <A runs.json> <B runs.json> > eval.md
import { readFileSync } from 'node:fs';

const [fa, fb] = process.argv.slice(2);
const A = JSON.parse(readFileSync(fa, 'utf8'));
const B = JSON.parse(readFileSync(fb, 'utf8'));
const out = [];
const P = (...a) => out.push(a.join(''));
const fx = (x, d = 2) => (x === null || x === undefined || Number.isNaN(x) ? '–' : Number.isFinite(x) ? x.toFixed(d) : String(x));
function q(arr, p) {
  const a = arr.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  return a.length ? a[Math.min(a.length - 1, Math.max(0, Math.ceil(p * a.length) - 1))] : NaN;
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
const byName = new Map(A.runs.map((r) => [r.name, r]));
const same = B.runs.filter((r) => byName.get(r.name)?.hash === r.hash);
const diff = B.runs.filter((r) => byName.get(r.name)?.hash !== r.hash);

P('# R1c A/B 汇总（scripts/r1c-eval.mjs 生成）');
P('');
P(`A = ${A.version}（R1c ${A.r1c.enabled ? '启用' : '关闭'}），B = ${B.version}（R1c ${B.r1c.enabled ? '启用' : '关闭'}）。B 参数：${JSON.stringify(B.r1c)}`);
P('');
P(`## 1. 影响范围`);
P('');
P(`180 场中逐步状态 hash 与 A 相同 ${same.length} 场，不同 ${diff.length} 场。不同的场次：${diff.map((r) => r.name).join('、')}。其中非针尖对针尖场次 ${diff.filter((r) => !r.nn).length} 场；针尖对针尖但 hash 相同 ${same.filter((r) => r.nn).length} 场。`);
P('');
const nn = B.runs.filter((r) => r.nn);
P('## 2. 针尖对针尖逐场对照（全部 24 场，含失败）');
P('');
T(
  ['场景', '结果 A → B', '时长 s A → B', '最长低速段 s A → B', '最长低速段开始 s（B）', '该段开始时转速比例（B）', '低速总时长 s A → B', '几何接触段 A → B', '撞击事件 A → B', '启动次数', '退出原因', '贴墙步 A/B', '最大速度 A/B'],
  nn.map((r) => {
    const a = byName.get(r.name);
    const ex = {};
    for (const x of r.acts) ex[x.exit] = (ex[x.exit] ?? 0) + 1;
    return [r.name, `${a.result} → ${r.result}`, `${fx(a.duration, 1)} → ${fx(r.duration, 1)}`, `${fx(a.lowLongest, 1)} → ${fx(r.lowLongest, 1)}`, fx(r.lowLongestStart, 1), r.lowLongestSpinRatio.map((x) => fx(x, 2)).join('/'), `${fx(a.lowTotal, 1)} → ${fx(r.lowTotal, 1)}`, `${a.contactSegs} → ${r.contactSegs}`, `${a.hits} → ${r.hits}`, r.acts.length, Object.entries(ex).map(([k, v]) => `${k} ${v}`).join(' '), `${a.wallSteps}/${r.wallSteps}`, `${fx(a.maxSpeed, 2)}/${fx(r.maxSpeed, 2)}`];
  }),
);
const sum = (rs, f) => rs.reduce((x, r) => x + f(r), 0);
const nnA = nn.map((r) => byName.get(r.name));
P(`合计（24 场）：低速总时长 A ${fx(sum(nnA, (r) => r.lowTotal), 1)} s → B ${fx(sum(nn, (r) => r.lowTotal), 1)} s；对局总时长 A ${fx(sum(nnA, (r) => r.duration), 1)} s → B ${fx(sum(nn, (r) => r.duration), 1)} s；低速占比 A ${fx((100 * sum(nnA, (r) => r.lowTotal)) / sum(nnA, (r) => r.duration), 1)}% → B ${fx((100 * sum(nn, (r) => r.lowTotal)) / sum(nn, (r) => r.duration), 1)}%。最长低速段 A ${dist(nnA.map((r) => r.lowLongest), 1)} → B ${dist(nn.map((r) => r.lowLongest), 1)}。`);
P('');

{
  const agg = {};
  for (const r of nn) for (const [k, v] of Object.entries(r.lowByR1cState ?? {})) agg[k] = (agg[k] ?? 0) + v;
  const tot = Object.values(agg).reduce((x, y) => x + y, 0);
  P('B 中低速时间按 R1c 状态 / 分类不成立的原因拆分（24 场合计；idle/dwell 下列出第一条不成立的条件，dwell = 分类成立、计时中）：');
  P('');
  T(['状态 / 原因', '秒', '占比'], Object.entries(agg).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, fx(v, 1), `${fx((100 * v) / tot, 1)}%`]));
}
const acts = nn.flatMap((r) => r.acts.map((a) => ({ ...a, run: r.name })));
P(`## 3. 每次恢复（B，${acts.length} 次）`);
P('');
const ex = {};
for (const a of acts) ex[a.exit] = (ex[a.exit] ?? 0) + 1;
P(`- 退出原因：${Object.entries(ex).map(([k, v]) => `${k} ${v}`).join('，')}`);
P(`- 启动前连续低速时长（s）：${dist(acts.map((a) => a.lowBefore), 2)}`);
P(`- 启动时刀刃间隙（m）：${dist(acts.map((a) => a.gap0), 3)}；其中间隙 > 0（未接触）${acts.filter((a) => a.gap0 > 0).length} 次`);
P(`- 启动时转速比例（每台）：${dist(acts.flatMap((a) => a.spinRatio0), 2)}`);
P(`- 净位移（真实坐标，每台）：启动前 3 s ${dist(acts.flatMap((a) => a.netPre3 ?? []), 3)}；启动后 1 s ${dist(acts.flatMap((a) => a.netPost1 ?? []), 3)}；启动后 3 s ${dist(acts.flatMap((a) => a.netPost3 ?? []), 3)}`);
P(`- 路径（每台）：启动前 3 s ${dist(acts.flatMap((a) => a.pathPre3 ?? []), 3)}；启动后 3 s ${dist(acts.flatMap((a) => a.pathPost3 ?? []), 3)}`);
P(`- 恢复时长（s）：${dist(acts.map((a) => a.t1 - a.t0), 3)}`);
P(`- 3 s 内发生几何接触：${acts.filter((a) => a.reContactT !== null).length}/${acts.length}，用时 ${dist(acts.map((a) => a.reContactT ?? NaN), 3)} s`);
P(`- 施力方向与拦截方向夹角（度，每次平均）：${dist(acts.map((a) => a.biasAngleMean), 1)}；最大 ${dist(acts.map((a) => a.biasAngleMax), 1)}。自然牵引方向与拦截方向夹角（每次平均）：${dist(acts.map((a) => a.naturalAngleMean), 1)}`);
P(`- 施力步数（每台）：${dist(acts.flatMap((a) => a.pushSteps), 0)}；累计 Δv（m/s，每台）：${dist(acts.flatMap((a) => a.deltaV), 3)}`);
P(`- 恢复期间最大水平速度（m/s）：${dist(acts.map((a) => a.maxSpeed), 3)}；启动后 3 s 内最大速度：${dist(acts.map((a) => a.maxSpeed3), 3)}；启动后 3 s 内最大半径：${dist(acts.map((a) => a.maxR3), 3)} m`);
P(`- 转速变化（rad/s，每台，恢复期间总损失）：${dist(acts.flatMap((a) => a.spinLoss), 2)}；其中辅助消耗：${dist(acts.flatMap((a) => a.assistSpinCost), 3)}`);
const gaps = [];
for (const r of nn) for (let i = 1; i < r.acts.length; i++) gaps.push(r.acts[i].t0 - r.acts[i - 1].t1);
P(`- 同场相邻两次恢复的间隔（s）：${dist(gaps, 2)}；每场启动次数：${dist(nn.map((r) => r.acts.length), 0)}`);
P('');
P('全部恢复记录：');
P('');
T(
  ['场景', 't0', '时长', '退出', '间隙0', '转速比例0', '前3s净位移', '后1s净位移', '后3s净位移', '接触用时', 'Δv', '最大速度', '偏置夹角均值', '自然夹角均值'],
  acts.map((a) => [a.run, fx(a.t0, 2), fx(a.t1 - a.t0, 3), a.exit, fx(a.gap0, 3), a.spinRatio0.map((x) => fx(x, 2)).join('/'), (a.netPre3 ?? []).map((x) => fx(x, 3)).join('/'), (a.netPost1 ?? []).map((x) => fx(x, 3)).join('/'), (a.netPost3 ?? []).map((x) => fx(x, 3)).join('/'), fx(a.reContactT, 3), a.deltaV.map((x) => fx(x, 2)).join('/'), fx(a.maxSpeed, 2), fx(a.biasAngleMean, 0), fx(a.naturalAngleMean, 0)]),
);
P('## 4. 其他组合');
P('');
const other = B.runs.filter((r) => !r.nn);
P(`非针尖对针尖 ${other.length} 场：B 中启动次数合计 ${sum(other, (r) => r.acts.length)}；hash 与 A 相同 ${other.filter((r) => byName.get(r.name)?.hash === r.hash).length} 场。`);
console.log(out.join('\n'));
