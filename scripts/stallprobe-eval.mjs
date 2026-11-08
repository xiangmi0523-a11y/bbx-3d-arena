/**
 * 低速停滞探针汇总：node scripts/stallprobe-eval.mjs <dir>  （dir 下有 A/ B/ R1a/ R1b/ 各自的 runs.json）
 * 输出 Markdown 表格到 stdout。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'test-results/stallprobe';
const load = (v) => (existsSync(join(dir, v, 'runs.json')) ? JSON.parse(readFileSync(join(dir, v, 'runs.json'), 'utf8')) : null);
const A = load('A');
const B = load('B');
const R1a = load('R1a');
const R1b = load('R1b');
const R1a30 = load('R1a30');
const DT = 1 / 120;
const q = (a, p) => {
  const s = a.filter(Number.isFinite).sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN;
};
const f = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const pct = (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—');
const dist = (a, d = 2) => `${a.length} / ${f(q(a, 0.5), d)} / ${f(q(a, 0.9), d)} / ${f(Math.max(...a.filter(Number.isFinite), -Infinity), d)}`;
const MAIN = ['AvD', 'DvA', 'SvA', 'BvB', 'AvA', 'DFLT', 'POWER'];
const combo = (r) => {
  const t = r.tips.map((x) => (x.includes('needle') ? 'needle' : x.includes('ball') ? 'ball' : x.includes('flat') ? 'flat' : x.includes('rubber') ? 'rubber' : x));
  return t.sort().join('-');
};
const out = [];
const p = (s = '') => out.push(s);

// ── 1. 证据总览 ──
p('## 1. 接触证据总览（B = cb4c2c4 当前行为）');
p();
p('| 组 | 场次 | 总步数 | 确认接触步 | 弱证据步 | 无证据步 | XZ 投影重叠但无证据 | 确认接触但 XZ 不重叠 | 历史口径“接触”步 | 其中确认 / 弱 | 历史口径最长段(s) | 物理接触最长段 H6(s) |');
p('|---|---|---|---|---|---|---|---|---|---|---|---|');
const groupsOf = (rs) => [...new Set(rs.map((r) => r.group))];
const rowT = (name, rs) => {
  const s = (k) => rs.reduce((x, r) => x + r.tally[k], 0);
  p(`| ${name} | ${rs.length} | ${s('steps')} | ${s('confirmed')} | ${s('weak')} | ${s('none')} | ${s('overlapNoContact')} | ${s('contactNoOverlap')} | ${s('oldTouch')} | ${pct(s('oldTouchConfirmed') / s('oldTouch'))} / ${pct(s('oldTouchWeak') / s('oldTouch'))} | ${f(Math.max(...rs.map((r) => r.tally.oldLongest)))} | ${f(Math.max(...rs.map((r) => r.tally.physLongestH6)))} |`);
};
for (const g of groupsOf(B.runs)) rowT(g, B.runs.filter((r) => r.group === g));
rowT('**全部**', B.runs);
p();
const P = {};
for (const r of B.runs) for (const [k, v] of Object.entries(r.tally.pairs)) P[k] = (P[k] ?? 0) + v;
const s = (k) => B.runs.reduce((x, r) => x + r.tally[k], 0);
p(`- 确认接触按碰撞体对：${Object.entries(P).map(([k, v]) => `${k} ${v}`).join('，')}`);
p(`- 有接触点但无求解器接触：${s('manifoldNoSolver')} 步；有求解器接触但冲量为 0：${s('solverNoImpulse')} 步；有正冲量但无求解器接触：${s('impulseNoSolver')} 步`);
p(`- ContactFeedback phase 非 idle 但本步无任何证据：${s('cfBusyNoContact')} 步；phase 为 idle 但本步确认接触：${s('cfIdleConfirmed')} 步`);
p();

// ── 2. 退出容忍 ──
p('## 2. 接触段对退出容忍的敏感度（进入 = 确认接触；退出 = 连续 H 步无确认）');
p();
p('| H（步） | H（ms） | 接触段数 | 0.25 s 内重新进入（抖动） | 段时长 P50 / P90 / 最大 (s) | 总接触时长 (s) |');
p('|---|---|---|---|---|---|');
B.runs[0].contactHyst.forEach((_, k) => {
  const segs = B.runs.reduce((x, r) => x + r.contactHyst[k].segs, 0);
  const fl = B.runs.reduce((x, r) => x + r.contactHyst[k].flaps, 0);
  const tot = B.runs.reduce((x, r) => x + r.contactHyst[k].total, 0);
  const H = B.runs[0].contactHyst[k].H;
  p(`| ${H} | ${f(H * DT * 1000, 0)} | ${segs} | ${fl} | 每场 P50 中位 ${f(q(B.runs.map((r) => r.contactHyst[k].p50), 0.5), 3)} / 每场 P90 中位 ${f(q(B.runs.map((r) => r.contactHyst[k].p90), 0.5), 3)} / ${f(Math.max(...B.runs.map((r) => r.contactHyst[k].max)), 3)} | ${f(tot, 1)} |`);
});
p();

// ── 3. WATCH 候选段 ──
const eps = (runs, V) => runs.flatMap((r) => r.watch.find((w) => w.V === V).eps.map((e) => ({ ...e, run: r.name, group: r.group, combo: combo(r), maxSeconds: r.maxSeconds, result: r.result })));
p('## 3. WATCH 候选段（未处于接触[H=6] + 双方水平速度 < V + 双方转速 > 10 rad/s）');
p();
for (const V of [0.2, 0.4, 0.8]) {
  const E = eps(B.runs, V);
  p(`### V = ${V} m/s（B，150 场）`);
  p();
  p('| 轴心组合 | 段数 / 时长 P50 / P90 / 最大 (s) | 进入起累计路径长 max(两台) P50 / P90 (m) | 净位移 max(两台) P50 / P90 (m) | 结束：接触 / 速度恢复 / 转速 < 10 / 对局结束 | 段内弱证据占比 P90 | 段内 XZ 重叠占比 P90 |');
  p('|---|---|---|---|---|---|---|');
  for (const c of [...new Set(E.map((e) => e.combo))].sort()) {
    const e = E.filter((x) => x.combo === c);
    const cnt = (k) => e.filter((x) => x.end === k).length;
    p(`| ${c} | ${dist(e.map((x) => x.dur))} | ${f(q(e.map((x) => Math.max(...x.path)), 0.5))} / ${f(q(e.map((x) => Math.max(...x.path)), 0.9))} | ${f(q(e.map((x) => Math.max(...x.net)), 0.5))} / ${f(q(e.map((x) => Math.max(...x.net)), 0.9))} | ${cnt('contact')} / ${cnt('speed')} / ${cnt('spin')} / ${cnt('end')} | ${pct(q(e.map((x) => x.uncertainFrac), 0.9))} | ${pct(q(e.map((x) => x.overlapFrac), 0.9))} |`);
  }
  p();
}

// ── 4. DEADLOCK 候选网格 ──
p('## 4. DEADLOCK 候选网格（V = 0.4；段时长 ≥ T 且进入起两台路径长都 < D）');
p();
p('每格：满足条件的段数（涉及场次）｜其中 needle-needle 段数｜在输家进入死亡阶段（转速比 < 0.2）之前就靠自己结束（接触 / 速度恢复）的段数 = 该阈值下的“误判”候选。');
p();
const E4 = eps(B.runs, 0.4).map((e) => ({ ...e, deathT0: B.runs.find((r) => r.name === e.run).deathT0 }));
const selfHeal = (e) => (e.end === 'contact' || e.end === 'speed') && !(Number.isFinite(e.deathT0) && e.t1 >= e.deathT0);
const Ts = [1, 2, 3, 5, 10];
const Ds = [0.1, 0.3, 0.5, 1.0, 2.0];
p(`| T \\ D | ${Ds.map((d) => `${d} m`).join(' | ')} |`);
p(`|---|${Ds.map(() => '---').join('|')}|`);
for (const T of Ts) {
  const cells = Ds.map((D) => {
    // “T 秒时的路径长”按 总路径 × T / 段时长 线性估计（平均速度近似）
    const c = E4.filter((e) => e.dur >= T && Math.max(...e.path) * (T / e.dur) < D);
    return `${c.length}（${new Set(c.map((e) => e.run)).size} 场）｜针尖 ${c.filter((e) => e.combo === 'needle-needle').length}｜自愈 ${c.filter(selfHeal).length}`;
  });
  p(`| ${T} s | ${cells.join(' | ')} |`);
}
p();
p('按段平均移动速度（路径长 / 时长，取两台较大者）区分：');
p();
p('| 组合（V=0.4，时长 ≥ 3 s） | 段数 | 平均移动速度 P50 / 最大 (m/s) | 起始转速比例 P50 | 段内牵引施加占比 P50 |');
p('|---|---|---|---|---|');
for (const c of [...new Set(E4.filter((e) => e.dur >= 3).map((e) => e.combo))].sort()) {
  const e = E4.filter((x) => x.dur >= 3 && x.combo === c);
  const run = (x) => B.runs.find((r) => r.name === x.run);
  p(`| ${c} | ${e.length} | ${f(q(e.map((x) => Math.max(...x.path) / x.dur), 0.5), 3)} / ${f(Math.max(...e.map((x) => Math.max(...x.path) / x.dur)), 3)} | ${f(q(e.map((x) => Math.min(...x.spin0) / 150), 0.5))}（按 spin/150 粗估） | ${pct(q(e.map((x) => Math.min(...x.appliedFrac)), 0.5))} |`);
}
p();
p('注：段内只保存了路径长总量，“T 秒时的路径长”按 总路径 × T / 段时长 线性估计（平均速度近似）；逐步时间序列（series/*.csv）可精确复核个例。');
p();
p('### V = 0.4、时长 ≥ 3 s 的全部段（不省略）');
p();
p('| 场景 | 组合 | 起 (s) | 时长 (s) | 结束 | 路径长 a/b (m) | 净位移 a/b (m) | 刀刃间隙 min/max | 起始转速 a/b | 段内牵引施加占比 a/b | 进动方向·意图>0 占比 a/b | 起点在死亡阶段 / 与死亡阶段重叠比例 |');
p('|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const e of E4.filter((x) => x.dur >= 3).sort((x, y) => y.dur - x.dur)) p(`| ${e.run} | ${e.combo} | ${e.t0} | ${f(e.dur)} | ${e.end} | ${e.path.map((x) => f(x)).join('/')} | ${e.net.map((x) => f(x)).join('/')} | ${f(e.gapMin, 3)}/${f(e.gapMax, 3)} | ${e.spin0.map((x) => f(x, 0)).join('/')} | ${e.appliedFrac.map(pct).join('/')} | ${e.gateOkFrac.map(pct).join('/')} | ${e.startInDeath ? '是' : '否'} / ${pct(e.deathOverlap)} |`);
p();

// ── 5. A 配置：旧通用僵持触发时的证据 ──
p('## 5. A（stallBreak = 1，旧通用僵持开启）：每次触发时的物理证据');
p();
const tr = A.runs.flatMap((r) => r.stallTrig.map((t) => ({ ...t, run: r.name, group: r.group })));
for (const kind of ['stall', 'wobble']) {
  const t = tr.filter((x) => x.kind === kind);
  const c = (e) => t.filter((x) => x.evidence === e).length;
  p(`- ${kind === 'stall' ? '通用僵持' : 'death wobble'}：${t.length} 次；触发时 确认接触 ${c(2)}、弱证据 ${c(1)}、无证据 ${c(0)}；XZ 投影重叠 ${t.filter((x) => x.overlapXZ).length}；三维距离 P50 ${f(q(t.map((x) => x.dist3d), 0.5), 3)} m`);
}
const sumG = (rs) => ({ dur: rs.reduce((x, r) => x + r.duration, 0) / rs.length, conf: rs.reduce((x, r) => x + r.tally.confirmed, 0) });
p();
p('| 组 | 平均时长 A / B (s) | 确认接触步 A / B | 物理接触最长段 H6 A / B (s) | WATCH(0.4) ≥ 3 s 段数 A / B |');
p('|---|---|---|---|---|');
for (const g of groupsOf(B.runs)) {
  const a = A.runs.filter((r) => r.group === g);
  const b = B.runs.filter((r) => r.group === g);
  const w3 = (rs) => eps(rs, 0.4).filter((e) => e.dur >= 3).length;
  p(`| ${g} | ${f(sumG(a).dur, 1)} / ${f(sumG(b).dur, 1)} | ${sumG(a).conf} / ${sumG(b).conf} | ${f(Math.max(...a.map((r) => r.tally.physLongestH6)))} / ${f(Math.max(...b.map((r) => r.tally.physLongestH6)))} | ${w3(a)} / ${w3(b)} |`);
}
p();

// ── 6. R1 ──
for (const [name, R] of [['R1a（tip 咬合 0.35 = breakoutGrip，无 edgeOnly 门控）', R1a], ['R1a30（tip 咬合 0.3，无 edgeOnly 门控，与 R1b 同咬合对照）', R1a30], ['R1b（借 edgeGrip 0.3，走现有 edgeOnly 门控代码路径）', R1b]]) {
  if (!R) continue;
  const acts = R.runs.flatMap((r) => (r.r1?.acts ?? []).map((a) => ({ ...a, run: r.name, group: r.group, combo: combo(r) })));
  p(`## 6. ${name}：${acts.length} 次启动（${new Set(acts.map((a) => a.run)).size} 场）`);
  p();
  p('| 组合 | 启动次数 | 恢复移动(速度>0.4 或 路径>0.3) 比例 / 用时 P50 / P90 (s) | 重新确认接触 比例 / 用时 P50 / P90 (s) | 2 s / 5 s / 10 s 内重新接触 | 结束：接触 / 转速<10 / 对局结束 | 首个证据→确认 用时 P90 (s) | 期间转速损失 P50 (rad/s) | 期间最大半径 max | 期间靠墙(>4.8 m)步数 max | 期间 wobble 触发 |');
  p('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const c of [...new Set(acts.map((a) => a.combo))].sort()) {
    const a = acts.filter((x) => x.combo === c);
    const mv = a.filter((x) => x.moveT !== null);
    const re = a.filter((x) => x.reT !== null);
    const within = (T) => pct(a.filter((x) => x.reT !== null && x.reT <= T).length / a.length);
    const cnt = (k) => a.filter((x) => x.end === k).length;
    p(`| ${c} | ${a.length} | ${pct(mv.length / a.length)} / ${f(q(mv.map((x) => x.moveT), 0.5))} / ${f(q(mv.map((x) => x.moveT), 0.9))} | ${pct(re.length / a.length)} / ${f(q(re.map((x) => x.reT), 0.5))} / ${f(q(re.map((x) => x.reT), 0.9))} | ${within(2)} / ${within(5)} / ${within(10)} | ${cnt('contact')} / ${cnt('spin')} / ${cnt('end')} | ${f(q(re.map((x) => x.reT - (x.firstEvidT ?? x.reT)), 0.9), 3)} | ${f(q(a.flatMap((x) => x.spinLoss), 0.5), 1)} | ${f(Math.max(...a.map((x) => x.maxR)))} | ${Math.max(0, ...a.map((x) => x.wallNearSteps))} | ${a.reduce((x, y) => x + y.wobbleDuring, 0)} |`);
  }
  const on = R.runs.reduce((x, r) => x + (r.r1?.r1Steps ?? [0, 0]).reduce((u, v) => u + v, 0), 0);
  p(`\n- R1 生效的台·步：${on}`);
  p();
  p('| 组 | 平均时长 B / R1 (s) | 结果变化场次 | 超时 / 120 s 强制 B / R1 | WATCH(0.4) ≥ 3 s 段数 B / R1 | WATCH(0.4) 最长 B / R1 (s) |');
  p('|---|---|---|---|---|---|');
  for (const g of groupsOf(B.runs)) {
    const b = B.runs.filter((r) => r.group === g);
    const r = R.runs.filter((x) => x.group === g);
    const ch = b.filter((x) => r.find((y) => y.name === x.name)?.result !== x.result).length;
    const to = (rs) => `${rs.filter((x) => x.result === 'timeout').length}/${rs.filter((x) => x.forced120).length}`;
    const w = (rs) => eps(rs, 0.4);
    p(`| ${g} | ${f(sumG(b).dur, 1)} / ${f(sumG(r).dur, 1)} | ${ch} | ${to(b)} / ${to(r)} | ${w(b).filter((e) => e.dur >= 3).length} / ${w(r).filter((e) => e.dur >= 3).length} | ${f(Math.max(0, ...w(b).map((e) => e.dur)))} / ${f(Math.max(0, ...w(r).map((e) => e.dur)))} |`);
  }
  p();
}
console.log(out.join('\n'));
