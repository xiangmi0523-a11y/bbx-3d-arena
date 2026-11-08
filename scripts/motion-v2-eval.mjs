/**
 * 第二轮修正对比表：读取 contactmix 输出（test-results/motion/cm-<名>.json），逐版本打印关键指标。
 *   node scripts/motion-v2-eval.mjs base new v2 v2-noedge ...
 */
import { readFileSync } from 'node:fs';
const med = (a) => {
  const s = a.filter(Number.isFinite).sort((x, y) => x - y);
  return s.length ? s[s.length >> 1] : NaN;
};
const mean = (a) => {
  const s = a.filter(Number.isFinite);
  return s.length ? s.reduce((x, y) => x + y, 0) / s.length : NaN;
};
const G = ['AvD', 'DvA', 'SvA', 'BvB', 'AvA', 'DFLT'];
const f = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const pct = (v) => (Number.isFinite(v) ? `${Math.round(v * 100)}%` : '—');
const rows = [];
for (const v of process.argv.slice(2)) {
  const d = JSON.parse(readFileSync(`test-results/motion/cm-${v}.json`, 'utf8'));
  const runs = G.flatMap((g) => d[g] ?? []);
  const T = runs.reduce((s, r) => s + r.duration, 0);
  const cs = runs.flatMap((r) => r.contacts).filter((c) => Number.isFinite(c.cut));
  const W = d.WALLX ?? [];
  const wT = W.reduce((s, r) => s + r.duration, 0);
  const wper = W.map((r) => (r.walls.length / r.duration) * 10);
  const opening = (rs) => rs.filter((r) => (r.contacts[0]?.t0 ?? 99) < 0.8).length / (rs.length || 1);
  const preFirst = (rs) => rs.reduce((s, r) => s + r.walls.filter((w) => w.t < (r.contacts[0]?.t0 ?? 99)).length, 0);
  const deathRuns = ['BvB', 'POWERX'].flatMap((g) => d[g] ?? []);
  const results = runs.map((r) => r.result.split(':')[1] ?? 'timeout');
  const cnt = (k) => results.filter((x) => x === k).length;
  rows.push({
    v,
    '开局0.8s接触(矩阵)': pct(opening(runs)),
    '开局0.8s接触(撞墙60)': pct(opening(W)),
    '首触前撞墙(矩阵/撞墙60)': `${preFirst(runs)}/${preFirst(W)}`,
    切入角中位: `${f(med(cs.map((c) => c.cut)), 0)}°`,
    斜切占比: pct(cs.filter((c) => c.cut > 30).length / cs.length),
    '接触/10s': f((runs.reduce((s, r) => s + r.contacts.length, 0) / T) * 10),
    '中强撞/10s': f((runs.reduce((s, r) => s + r.strong, 0) / T) * 10),
    '最长接触(最大)': f(Math.max(...runs.map((r) => Math.max(0, ...r.contacts.map((c) => c.t1 - c.t0))))),
    '>1s接触': runs.flatMap((r) => r.contacts).filter((c) => c.t1 - c.t0 > 1).length,
    '死亡阶段接触(BvB均值)': pct(mean(deathRuns.map((r) => r.death))),
    '撞墙/10s(矩阵)': f((runs.reduce((s, r) => s + r.walls.length, 0) / T) * 10),
    'SvA撞墙/10s': f(((d.SvA ?? []).reduce((s, r) => s + r.walls.length, 0) / (d.SvA ?? []).reduce((s, r) => s + r.duration, 1e-9)) * 10),
    '撞墙60:/10s': f((W.reduce((s, r) => s + r.walls.length, 0) / wT) * 10),
    '撞墙60:通过率': pct(wper.filter((x) => x < 1.2).length / (W.length || 1)),
    '撞墙60:前2s': W.reduce((s, r) => s + r.walls.filter((w) => w.t < 2).length, 0),
    '撞墙60:2s后': W.reduce((s, r) => s + r.walls.filter((w) => w.t >= 2).length, 0),
    '平均时长': f(T / runs.length, 1),
    '结束方式 spin/over/xtreme/burst/timeout': ['spin', 'over', 'xtreme', 'burst', 'timeout'].map(cnt).join('/'),
  });
}
const keys = Object.keys(rows[0]);
console.log(`| 指标 | ${rows.map((r) => r.v).join(' | ')} |`);
console.log(`|---|${rows.map(() => '---').join('|')}|`);
for (const k of keys.slice(1)) console.log(`| ${k} | ${rows.map((r) => r[k]).join(' | ')} |`);
