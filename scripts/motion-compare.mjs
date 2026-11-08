// 自主运动对比表：node scripts/motion-compare.mjs base.json [new.json] > out.md
import { readFileSync } from 'node:fs';

const [baseF, newF] = process.argv.slice(2);
const base = JSON.parse(readFileSync(baseF, 'utf8'));
const neu = newF ? JSON.parse(readFileSync(newF, 'utf8')) : null;

const avg = (a) => {
  const v = a.filter(Number.isFinite);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN;
};
const sum = (a) => a.reduce((s, x) => s + x, 0);
const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '-');
const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(0)}%` : '-');

/** 每组的汇总指标 */
function summarize(rs) {
  const dur = sum(rs.map((r) => r.duration));
  const both = (k) => avg(rs.flatMap((r) => [r.p[k], r.r[k]]));
  return {
    n: rs.length,
    dur: dur / rs.length,
    pCos: avg(rs.map((r) => r.p.pursuitCos)),
    rCos: avg(rs.map((r) => r.r.pursuitCos)),
    pChase: avg(rs.map((r) => r.p.chaseFrac)),
    rChase: avg(rs.map((r) => r.r.chaseFrac)),
    longestChase: Math.max(...rs.flatMap((r) => [r.p.longestChase, r.r.longestChase])),
    orbit: both('orbitFrac'),
    away: both('awayFrac'),
    turn: both('turnRate'),
    straight: both('straightFrac'),
    speedP: avg(rs.map((r) => r.p.meanSpeed)),
    speedR: avg(rs.map((r) => r.r.meanSpeed)),
    precRate: both('precRate'),
    precStd: both('precRateStd'),
    dist: avg(rs.map((r) => r.distMean)),
    distStd: avg(rs.map((r) => r.distStd)),
    contacts10: (sum(rs.map((r) => r.contacts)) / dur) * 10,
    contactFrac: avg(rs.map((r) => r.contactFrac)),
    longestContact: Math.max(...rs.map((r) => r.longestContact)),
    meanContact: avg(rs.map((r) => r.meanContact)),
    sep10: (sum(rs.map((r) => r.separations)) / dur) * 10,
    re10: (sum(rs.map((r) => r.reengages)) / dur) * 10,
    reTime: avg(rs.map((r) => r.reengageTime)),
    longestGap: Math.max(...rs.map((r) => r.longestGap)),
    cut: avg(rs.map((r) => r.cutAngleMedian)),
    oblique: avg(rs.map((r) => r.obliqueFrac)),
    approach: avg(rs.map((r) => r.approachMedian)),
    postTurn: avg(rs.map((r) => r.postTurn)),
    hits10: (sum(rs.map((r) => r.hits)) / dur) * 10,
    strong10: (sum(rs.map((r) => r.strong)) / dur) * 10,
    grind10: (sum(rs.map((r) => r.grinds)) / dur) * 10,
    breakouts: sum(rs.map((r) => r.breakouts)),
    edge: both('edgeFrac'),
    dash: both('dashFrac'),
    meanRP: avg(rs.map((r) => r.p.meanR)),
    meanRR: avg(rs.map((r) => r.r.meanR)),
    wall: avg(rs.map((r) => r.wall10)),
    out: rs.filter((r) => r.finish === 'over' || r.finish === 'xtreme').length,
    timeout: rs.filter((r) => r.finish === 'timeout').length,
    spin10P: avg(rs.map((r) => r.p.spin10)),
    spin10R: avg(rs.map((r) => r.r.spin10)),
    winsP: rs.filter((r) => r.winner === 'player').length,
    energy: Math.max(...rs.map((r) => r.energyMaxRatio)),
    gapMed: avg(rs.map((r) => r.gapMedian)),
    rebutt: avg(rs.map((r) => r.rebuttFrac)),
    relTan: avg(rs.map((r) => r.relTangential)),
    los: avg(rs.map((r) => r.losTurn10)),
    hist: [0, 1, 2, 3, 4].map((i) => avg(rs.flatMap((r) => [r.p.cosHist[i], r.r.cosHist[i]]))),
    states: (() => {
      const acc = {};
      for (const r of rs) for (const sd of [r.p, r.r]) for (const [k, v] of Object.entries(sd.states)) acc[k] = (acc[k] ?? 0) + v / (rs.length * 2);
      return Object.entries(acc).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`).join('，');
    })(),
    switches: both('switches10'),
    knock: both('knock10'),
    acP: avg(rs.map((r) => r.p.accelCos)),
    acR: avg(rs.map((r) => r.r.accelCos)),
    lockP: avg(rs.map((r) => r.p.accelLock)),
    lockR: avg(rs.map((r) => r.r.accelLock)),
    cusps: both('cusps10'),
    results: rs.map((r) => r.result.replace('player', 'P').replace('rival', 'R')).join(' '),
  };
}

const ROWS = [
  ['平均时长 s', 'dur', 1],
  ['玩家 运动方向·指向对手 cos（1 = 一直正对冲）', 'pCos', 2],
  ['对手 运动方向·指向对手 cos', 'rCos', 2],
  ['玩家 正面追击占比（cos>0.85）', 'pChase', 'pct'],
  ['对手 正面追击占比', 'rChase', 'pct'],
  ['最长连续正面追击 s', 'longestChase', 1],
  ['环绕占比（|cos|<0.4，距离<3.5）', 'orbit', 'pct'],
  ['远离占比（cos<−0.5）', 'away', 'pct'],
  ['加速度方向·指向对手 cos（玩家 / 对手）', ['acP', 'acR'], 2],
  ['加速度锁定对手占比 cos>0.8（玩家 / 对手）', ['lockP', 'lockR'], 'pct'],
  ['急停折返（0.25 s 内转向 >120°）/10s（每台）', 'cusps', 2],
  ['相对速度切向占比（0 = 沿连心线直来直去，1 = 纯环绕）', 'relTan', 2],
  ['连心线累计转角 rad/10s（互相环绕程度）', 'los', 1],
  ['再接触前最大拉开距离 m（中位数）', 'gapMed', 2],
  ['顶牛占比（未拉开 0.6 m 就再撞）', 'rebutt', 'pct'],
  ['cos 分布 [−1,−.6,−.2,.2,.6,1]', 'hist', 'hist'],
  ['运动状态占比', 'states', 'raw'],
  ['状态切换 /10s（每台）', 'switches', 2],
  ['被撞歪后相位跟随实际倾斜 /10s（每台）', 'knock', 2],
  ['速度方向变化率 rad/s', 'turn', 2],
  ['直线段占比（转向 <0.6 rad/s）', 'straight', 'pct'],
  ['玩家 / 对手 平均速度 m/s', ['speedP', 'speedR'], 2],
  ['进动角速度 rad/s（均值 / 标准差）', ['precRate', 'precStd'], 2],
  ['双方中心距 m（均值 / 标准差）', ['dist', 'distStd'], 2],
  ['接触次数 /10s', 'contacts10', 2],
  ['接触时间占比', 'contactFrac', 'pct'],
  ['最长连续接触 s', 'longestContact', 2],
  ['平均每段接触 s', 'meanContact', 2],
  ['脱离（外沿拉开 >0.6 m）/10s', 'sep10', 2],
  ['重新接近 /10s', 're10', 2],
  ['脱离到再接触平均 s', 'reTime', 2],
  ['最长无接触间隔 s', 'longestGap', 1],
  ['切入角中位数 °（0 = 正面直撞）', 'cut', 0],
  ['斜切（>30°）占比', 'oblique', 'pct'],
  ['接触时法向接近速度 m/s', 'approach', 2],
  ['接触前后运动方向变化 °', 'postTurn', 0],
  ['撞击事件 /10s（全部 / 中等以上）', ['hits10', 'strong10'], 2],
  ['贴身摩擦 /10s', 'grind10', 2],
  ['脱困触发次数（全组）', 'breakouts', 0],
  ['离中心平均距离 m（玩家 / 对手）', ['meanRP', 'meanRR'], 2],
  ['贴边时间占比', 'edge', 'pct'],
  ['撞墙 /10s（双方合计）', 'wall', 2],
  ['轨道冲刺时间占比', 'dash', 'pct'],
  ['出界 / 超时场数', ['out', 'timeout'], 0],
  ['10 秒时转速比例（玩家 / 对手）', ['spin10P', 'spin10R'], 2],
  ['玩家胜场', 'winsP', 0],
  ['系统总能量最大比值（>1 = 增能）', 'energy', 3],
];

function cell(s, key, fmt) {
  if (fmt === 'hist') return s[key].map(pct).join(' ');
  if (fmt === 'raw') return s[key];
  const one = (k) => (fmt === 'pct' ? pct(s[k]) : f(s[k], fmt));
  return Array.isArray(key) ? key.map(one).join(' / ') : one(key);
}

const lines = [];
for (const g of Object.keys(base)) {
  const sb = summarize(base[g]);
  const sn = neu?.[g] ? summarize(neu[g]) : null;
  lines.push(`### ${g}（${sb.n} 场）`, '');
  lines.push(sn ? '| 指标 | 基线 0dac2ad | 新版本 |' : '| 指标 | 值 |', sn ? '|---|---|---|' : '|---|---|');
  for (const [label, key, fmt] of ROWS) lines.push(`| ${label} | ${cell(sb, key, fmt)} |${sn ? ` ${cell(sn, key, fmt)} |` : ''}`);
  lines.push(`| 结果 | ${sb.results} |${sn ? ` ${sn.results} |` : ''}`, '');
}
console.log(lines.join('\n'));
