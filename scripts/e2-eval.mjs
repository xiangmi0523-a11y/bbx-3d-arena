// E2 牵引门槛反事实汇总（只读原始数据）。
//   node scripts/e2-eval.mjs <e2-A runs.json> <e2-B runs.json> <e2-G runs.json> > e2.md
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';

const [fa, fb, fg] = process.argv.slice(2);
const A = JSON.parse(readFileSync(fa, 'utf8')).runs;
const B = JSON.parse(readFileSync(fb, 'utf8')).runs;
const G = fg ? JSON.parse(readFileSync(fg, 'utf8')).runs : null;
const out = [];
const P = (...a) => out.push(a.join(''));
const fx = (x, d = 2) => (x === null || x === undefined || Number.isNaN(x) ? '–' : Number(x).toFixed(d));
const q = (arr, p) => {
  const a = arr.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  return a.length ? a[Math.min(a.length - 1, Math.max(0, Math.ceil(p * a.length) - 1))] : NaN;
};
const dist = (arr, d = 2) => {
  const a = arr.filter((x) => Number.isFinite(x));
  return a.length ? `n=${a.length} P10 ${fx(q(a, 0.1), d)} / P50 ${fx(q(a, 0.5), d)} / P90 ${fx(q(a, 0.9), d)} / max ${fx(Math.max(...a), d)}` : 'n=0';
};
const T = (head, rows) => {
  P('| ', head.join(' | '), ' |');
  P('|', head.map(() => '---').join('|'), '|');
  for (const r of rows) P('| ', r.join(' | '), ' |');
  P('');
};
const byA = new Map(A.map((r) => [r.name, r]));
const nnB = B.filter((r) => r.nn);
const nnA = nnB.map((r) => byA.get(r.name));
const CLS = ['stalled', 'intermittent', 'circling', 'towardOpponent', 'moving'];
const CN = { stalled: '停滞', intermittent: '短暂移动后再停滞', circling: '有路径无净位移（小半径绕圈）', towardOpponent: '向对手移动', moving: '持续运动（其他）' };

P('# E2 牵引门槛反事实汇总（scripts/e2-eval.mjs 生成）');
P('');
P('A = Stage A 原始门槛 driveMinGrip 0.2；B = 只在 24 场针尖对针尖的诊断运行中覆盖为 0.05；G（信息性）= 180 场全部覆盖。gearGrip 与其他一切不变，不加任何推力或控制器。');
P('');
P('## 1. 隔离性');
P('');
const sameB = B.filter((r) => byA.get(r.name).hash === r.hash);
P(`- B 与 A 逐步状态 hash：相同 ${sameB.length} 场，不同 ${B.length - sameB.length} 场；不同的全部是针尖对针尖：${B.filter((r) => byA.get(r.name).hash !== r.hash).every((r) => r.nn) ? '是' : '否'}；非针尖对针尖中不同 ${B.filter((r) => !r.nn && byA.get(r.name).hash !== r.hash).length} 场。`);
if (G) {
  const dg = G.filter((r) => !r.nn && byA.get(r.name).hash !== r.hash);
  P(`- G（全局覆盖，信息性）：非针尖对针尖中 hash 改变 ${dg.length} 场，全部是含针尖的组合：${[...new Set(dg.map((r) => r.tips.join(' vs ')))].join('；')}（分组 ${[...new Set(dg.map((r) => r.group))].join('、')}）。`);
}
P('');
P('## 2. 针尖对针尖逐场（全部 24 场，A → B）');
P('');
T(
  ['场景', '结果', '时长 s', '牵引施加比例 B（两台，占全部步）', '低速占比', '最长低速段 s', '几何接触段', '接触间隔 P50 / max s', '撞击事件', '最大速度 m/s', '最大半径 m', '贴墙步（r>4.75）', '转速损失 rad/s²（两台）', '最大非撞击加速度 m/s²'],
  nnB.map((r) => {
    const a = byA.get(r.name);
    return [r.name, `${a.result} → ${r.result}`, `${fx(a.duration, 1)} → ${fx(r.duration, 1)}`, r.tracShare.map((x) => fx(x)).join('/'), `${fx(a.lowShare)} → ${fx(r.lowShare)}`, `${fx(a.lowLongest, 1)} → ${fx(r.lowLongest, 1)}`, `${a.contactSegs} → ${r.contactSegs}`, `${fx(q(a.gaps, 0.5), 1)}/${fx(Math.max(...a.gaps, NaN), 1)} → ${fx(q(r.gaps, 0.5), 1)}/${fx(Math.max(...r.gaps, NaN), 1)}`, `${a.hits} → ${r.hits}`, `${fx(a.maxSpeed)} → ${fx(r.maxSpeed)}`, `${fx(a.maxR)} → ${fx(r.maxR)}`, `${a.wallSteps} → ${r.wallSteps}`, `${a.spinLossPerS.map((x) => fx(x, 2)).join('/')} → ${r.spinLossPerS.map((x) => fx(x, 2)).join('/')}`, `${fx(a.maxAccNoSmash, 0)} → ${fx(r.maxAccNoSmash, 0)}`];
  }),
);
const sum = (rs, f) => rs.reduce((p, r) => p + f(r), 0);
P(`合计：低速时间 A ${fx(sum(nnA, (r) => r.lowTotal), 1)} s / 对局 ${fx(sum(nnA, (r) => r.duration), 1)} s（${fx((100 * sum(nnA, (r) => r.lowTotal)) / sum(nnA, (r) => r.duration), 1)}%）→ B ${fx(sum(nnB, (r) => r.lowTotal), 1)} s / ${fx(sum(nnB, (r) => r.duration), 1)} s（${fx((100 * sum(nnB, (r) => r.lowTotal)) / sum(nnB, (r) => r.duration), 1)}%）。`);
P(`牵引施加比例（占全部步，每台）：A ${dist(nnA.flatMap((r) => r.tracShare))}；B ${dist(nnB.flatMap((r) => r.tracShare))}。占“着地且转速 > 2×最低稳定转速且未冲刺”的步：A ${dist(nnA.flatMap((r) => r.tracShareEligible))}；B ${dist(nnB.flatMap((r) => r.tracShareEligible))}。`);
P(`接触间隔（相邻几何接触段之间，s）：A ${dist(nnA.flatMap((r) => r.gaps), 1)}；B ${dist(nnB.flatMap((r) => r.gaps), 1)}。`);
P(`首次几何接触时刻（s）：A ${dist(nnA.map((r) => r.firstContact ?? NaN), 1)}；B ${dist(nnB.map((r) => r.firstContact ?? NaN), 1)}。`);
P(`转速比例（每台）t=30 s：A ${dist(nnA.flatMap((r) => r.spinAt.t30 ?? []))}；B ${dist(nnB.flatMap((r) => r.spinAt.t30 ?? []))}。`);
P('');
P('## 3. 10 s 窗口（从 10 s 起连续不重叠，每台每窗口一个样本）');
P('');
const wins = (rs) => rs.flatMap((r) => r.windows.flatMap((w) => w.per.map((p) => ({ ...p, run: r.name, t0: w.t0, geo: w.geoSteps }))));
const wA = wins(nnA);
const wB = wins(nnB);
const early = (rs) => rs.filter((r) => r.early).flatMap((r) => r.early.per.map((p) => ({ ...p, run: r.name })));
const refBy = (pred) => early(A.filter((r) => !r.nn && pred(r)));
const groups = [
  ['针尖对针尖 A（10 s 起）', wA],
  ['针尖对针尖 B（10 s 起）', wB],
  ['针尖对针尖 A（2–12 s）', early(nnA)],
  ['针尖对针尖 B（2–12 s）', early(nnB)],
  ['参照：其他 156 场 A（2–12 s，对局 ≥ 12 s 的全部）', refBy(() => true)],
  ['参照：含平底 gear-flat（2–12 s）', refBy((r) => r.tips.includes('gear-flat'))],
  ['参照：含橡胶 rush-rubber（2–12 s）', refBy((r) => r.tips.includes('rush-rubber'))],
  ['参照：球头对球头（2–12 s）', refBy((r) => r.tips.every((t) => t === 'dome-ball'))],
];
T(
  ['样本', '窗口数', ...CLS.map((c) => CN[c])],
  groups.map(([n, w]) => [n, w.length, ...CLS.map((c) => {
    const k = w.filter((x) => x.cls === c).length;
    return `${k}（${fx((100 * k) / Math.max(1, w.length), 0)}%）`;
  })]),
);
T(
  ['样本', '10 s 净位移 m', '10 s 路径 m', '净位移 / 路径', '回转半径 m', '自身速度 < 0.4 占比', '位移方向与对手方向 cos', '牵引施加占比'],
  groups.map(([n, w]) => [n, dist(w.map((x) => x.net)), dist(w.map((x) => x.path)), dist(w.map((x) => x.straightness)), dist(w.map((x) => x.gyration)), dist(w.map((x) => x.slowShare)), dist(w.map((x) => x.approachCos)), dist(w.map((x) => x.tracShare))]),
);
P('## 4. 速度与转速比例的关系（针尖对针尖逐步轨迹，按每台转速比例分箱，排除几何接触步）');
P('');
P('转速比例 = 当前转速 / 该台轨迹中的最大转速（≈ 发射转速）。理论对照（由代码参数推算，不是测量）：B 中牵引加速度 = driveAccel 30 × gearGrip 0.1 × 转速比例 = 3 × 比例 m/s²；滚动阻力 (0.02 + 0.02 × 0.12) × 20 = 0.448 m/s²；针尖–地面库仑摩擦上限 μg = 0.06 × 20 = 1.2 m/s²。');
P('');
const bins = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.01];
const binStat = (file) => {
  const dir = join(dirname(file), 'track');
  const acc = bins.map(() => ({ n: 0, v: 0, slow: 0 }));
  for (const r of (file === fa ? nnA : nnB)) {
    const f = join(dir, `${r.name.replace(/[^\w.#-]+/g, '_').replace('#', '_')}.csv.gz`);
    if (!existsSync(f)) continue;
    const rows = gunzipSync(readFileSync(f)).toString().split('\n').slice(1).map((l) => l.split(',').map(Number));
    const mx = [Math.max(...rows.map((x) => x[7])), Math.max(...rows.map((x) => x[8]))];
    for (const x of rows) {
      if (x[0] < 2 || x[9]) continue;
      for (let i = 0; i < 2; i++) {
        const ratio = x[7 + i] / mx[i];
        const k = bins.findIndex((b) => ratio < b);
        if (k < 1) continue;
        acc[k].n++;
        acc[k].v += x[5 + i];
        if (x[5 + i] < 0.4) acc[k].slow++;
      }
    }
  }
  return acc;
};
const sa = binStat(fa);
const sb = binStat(fb);
T(
  ['转速比例', '样本步 A / B', '平均速度 m/s A → B', '速度 < 0.4 占比 A → B', 'B 理论：牵引 − 摩擦上限 − 滚阻 m/s²'],
  bins.slice(1).map((b, j) => {
    const k = j + 1;
    const lo = bins[k - 1];
    const mid = (lo + Math.min(1, b)) / 2;
    return [`${fx(lo, 1)}–${fx(Math.min(1, b), 1)}`, `${sa[k].n} / ${sb[k].n}`, `${fx(sa[k].v / sa[k].n, 3)} → ${fx(sb[k].v / sb[k].n, 3)}`, `${fx(sa[k].slow / sa[k].n)} → ${fx(sb[k].slow / sb[k].n)}`, fx(3 * mid - 1.2 - 0.448, 2)];
  }),
);
P('## 5. 针尖对针尖 B 的全部窗口');
P('');
T(
  ['场景', '窗口起点 s', '台', '分类', '净位移', '路径', '净/路径', '回转半径', '速度<0.4 占比', 'cos(对手)', '牵引占比', '窗口内几何接触步', '起点转速'],
  nnB.flatMap((r) => r.windows.flatMap((w) => w.per.map((p, i) => [r.name, fx(w.t0, 0), i ? 'B' : 'A', CN[p.cls], fx(p.net), fx(p.path), fx(p.straightness), fx(p.gyration), fx(p.slowShare), fx(p.approachCos), fx(p.tracShare), w.geoSteps, fx(w.spin[i], 0)]))),
);
console.log(out.join('\n'));
