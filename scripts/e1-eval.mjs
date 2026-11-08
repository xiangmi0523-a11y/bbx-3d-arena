// E1 力学账本汇总（只读原始数据）。
//   node scripts/e1-eval.mjs <e1-A summary.json> <e1-B summary.json> > e1.md
import { readFileSync } from 'node:fs';

const [fa, fb] = process.argv.slice(2);
const A = JSON.parse(readFileSync(fa, 'utf8'));
const B = JSON.parse(readFileSync(fb, 'utf8'));
const out = [];
const P = (...a) => out.push(a.join(''));
const fx = (x, d = 3) => (x === null || x === undefined || Number.isNaN(x) ? '–' : Number(x).toFixed(d));
const T = (head, rows) => {
  P('| ', head.join(' | '), ' |');
  P('|', head.map(() => '---').join('|'), '|');
  for (const r of rows) P('| ', r.join(' | '), ' |');
  P('');
};
const st = (s, d = 3) => (s && s.n ? `n=${s.n} P10 ${fx(s.p10, d)} / P50 ${fx(s.p50, d)} / P90 ${fx(s.p90, d)} / max ${fx(s.max, d)}` : 'n=0');
const NAME = { trac: '轴心牵引（游戏代码）', roll: '滚动阻力（游戏代码）', dash: '齿轮冲刺（游戏代码）', smash: '撞击冲量 resolveSmash（游戏代码）', damp: '线性阻尼（Rapier，按源码公式）', nFloor: '地面法向冲量水平分量（Rapier 报告 × 8/9）', nStatic: '墙等静态体法向冲量', nBey: '对手法向冲量（Rapier 接触）', fric: '地面摩擦（推断：切平面内、锥内残差）', unexpl: '未解释残差' };
const TERMS = Object.keys(NAME);

P('# E1 水平力来源分解汇总（scripts/e1-eval.mjs 生成）');
P('');
P(`A = Stage A 原始门槛（driveMinGrip 0.2）；B = 诊断覆盖 driveMinGrip ${B.grip}（只对针尖对针尖）。场景 = 探针 V2 矩阵全部 24 场针尖对针尖，固定种子。`);
P('');
P('## 1. 数据有效性');
P('');
const chk = (S) => {
  const c = S.runs.map((r) => r.checks);
  return [Math.max(...c.map((x) => x.tangentReadMax)), c.reduce((p, x) => p + x.unclassified, 0), Math.max(...c.map((x) => x.preErrMax)), Math.max(...c.map((x) => x.postErrMax))];
};
T(
  ['组', 'Rapier 摩擦冲量读数（X、Y 绝对值之和）最大值', '无法归类的游戏代码冲量（次）', 'preStep 闭合误差最大（N·s）', 'postStep 闭合误差最大（N·s）', '有 10 s 窗口的场次'],
  [A, B].map((S) => {
    const c = chk(S);
    return [S.tag, fx(c[0], 6), c[1], c[2].toExponential(2), c[3].toExponential(2), `${S.runs.filter((r) => r.window).length}/24`];
  }),
);
P('');
P('## 2. A：24 个窗口逐窗口（每场最长低速段的前 10 s，含全部场次）');
P('');
T(
  ['场景', '窗口 s', '平均速度 m/s（两台）', '摩擦份额', '地面法向份额', '滚阻份额', '撞击份额', '牵引份额', '摩擦沿速度 m/s²', '法向沿速度 m/s²', '滚阻沿速度 m/s²', '残差 P50（两台）', '无几何接触的撞击步'],
  A.runs.map((r) => {
    const p = r.perBey;
    if (!p[0]) return [r.name, '无 ≥10 s 低速段', '', '', '', '', '', '', '', '', '', '', ''];
    const sh = (k) => p.map((q) => `${fx(100 * q.terms[k].share, 0)}%`).join('/');
    const al = (k) => p.map((q) => fx(q.terms[k].alongAcc, 2)).join('/');
    return [r.name, `${fx(r.window.t0, 1)}–${fx(r.window.t1, 1)}`, p.map((q) => fx(q.speed.mean, 3)).join('/'), sh('fric'), sh('nFloor'), sh('roll'), sh('smash'), sh('trac'), al('fric'), al('nFloor'), al('roll'), p.map((q) => `${fx(100 * q.rel.p50, 1)}%`).join('/'), p.map((q) => `${q.smashNoGeo}/${q.smashSteps}`).join(' ')];
  }),
);
for (const S of [A, B]) {
  const p = S.allLow;
  P(`## ${S === A ? 3 : 4}. ${S.tag}：全部低速步汇总（24 场合计，每台每步一个样本，共 ${p.steps} 个，${fx(p.seconds, 0)} 台·秒）`);
  P('');
  P(`接触组合：只有地面 ${p.kinds.floor}，无接触 ${p.kinds.none}，地面 + 墙 / 对手 ${p.kinds.mixed}，只有墙 / 对手 ${p.kinds.other}。牵引实际施加 ${p.tracSteps} 步（${fx((100 * p.tracSteps) / p.steps, 1)}%）。速度 ${st(p.speed)} m/s。`);
  P('');
  T(
    ['来源', '测量方式', '平均水平加速度 m/s²', '份额（按大小）', '沿速度方向 m/s²（正 = 推动）', '平均功率 W/kg（正 = 增加动能）'],
    TERMS.map((k) => [NAME[k], k === 'fric' ? '推断' : k === 'unexpl' ? '残差' : k === 'damp' ? '估算（实测速度 × 源码公式）' : k.startsWith('n') ? '实测（Rapier 报告值，子步修正）' : '实测（直接记录）', fx(p.terms[k].meanAcc, 4), `${fx(100 * p.terms[k].share, 1)}%`, fx(p.terms[k].alongAcc, 4), fx(p.terms[k].power, 5)]),
  );
  P(`- 每步相对残差 |未解释_水平| / |实测 Δv_水平|：${st(p.rel, 4)}`);
  P(`- 竖直方向残差 / (g·dt)（检验法向冲量 × 8/9 修正）：${st(p.unexplVertRel, 4)}`);
  P(`- 推断摩擦 / 库仑锥 μλ：${st(p.coneRatio, 3)}`);
  P(`- 推断摩擦大小 m/s²：${st(p.fricAcc, 3)}`);
  P(`- 接触点滑移速度（m/s，切平面内）：线速度项 ${st(p.slipLin, 4)}；绕轴自转项 ${st(p.slipSpin, 4)}；垂直于轴的角速度项 ${st(p.slipPerp, 4)}`);
  P(`- 推断摩擦与 −滑移方向夹角（度）：总滑移 ${st(p.angSlip, 1)}；只看自转项 ${st(p.angSpin, 1)}；只看垂直角速度项 ${st(p.angPerp, 1)}`);
  P(`- 推断摩擦与“垂直于实际转轴倾斜方向”的直线夹角（0–90°）：${st(p.lineTilt, 1)}`);
  P(`- 推断摩擦与 −速度方向夹角：${st(p.angVel, 1)}；与游戏自然牵引方向夹角：${st(p.angNat, 1)}；与下坡（指向中心）方向夹角：${st(p.angDown, 1)}`);
  P(`- 地面法向冲量水平分量的径向分量（m/s²，负 = 指向中心，实测）：${st(p.nRadial, 3)}；同位置解析坡度的理论值 −g·s/(1+s²)：${st(p.gTheory, 3)}`);
  P(`- 撞击冲量（resolveSmash）出现在低速步中 ${p.smashSteps} 步，其中无几何接触 ${p.smashNoGeo} 步`);
  P('');
}
console.log(out.join('\n'));
