// E5-A 结果汇总：隔离证明、五段物理链、10 s 窗口指标、安全与能量。
// 只读 test-results/e5a（或第一个参数）下 b0 / b0.3 / b0.6 的 summary.json 与逐步轨迹，输出 eval.json 与 markdown 表格。
//   node scripts/e5a-eval.mjs [目录] [Stage A 参考 hash 文件]
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const DIR = process.argv[2] ?? 'test-results/e5a';
const REF = process.argv[3] ?? 'research/e5/verify-A-vs-stageA.json';
const BS = ['0', '0.3', '0.6'];
const HZ = 120;
const WIN = 10 * HZ;

const sum = (a) => a.reduce((x, y) => x + y, 0);
const mean = (a) => (a.length ? sum(a) / a.length : NaN);
const q = (a, p) => {
  if (!a.length) return NaN;
  const s = Float64Array.from(a).sort();
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  return s[lo] + (s[Math.min(s.length - 1, lo + 1)] - s[lo]) * (i - lo);
};
const se = (a) => (a.length > 1 ? Math.sqrt(sum(a.map((x) => (x - mean(a)) ** 2)) / (a.length - 1) / a.length) : NaN);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const deg = (r) => (r * 180) / Math.PI;

const sums = Object.fromEntries(BS.map((b) => [b, JSON.parse(readFileSync(`${DIR}/b${b}/summary.json`, 'utf8'))]));
const ref = Object.fromEntries(JSON.parse(readFileSync(REF, 'utf8')).rows.map((r) => [r.name, r.baselineHash]));

// ---------- 1. 隔离证明 ----------
const iso = {};
{
  const r0 = Object.fromEntries(sums['0'].runs.map((r) => [r.name, r]));
  const s0 = sums['0'].runs;
  iso.b0VsStageA = { total: s0.length, same: s0.filter((r) => ref[r.name] === r.hash).length, differ: s0.filter((r) => ref[r.name] !== r.hash).map((r) => r.name) };
  for (const b of ['0.3', '0.6']) {
    const rs = sums[b].runs;
    const non = rs.filter((r) => !r.nn);
    const tgt = rs.filter((r) => r.nn);
    iso[`b${b}VsB0`] = {
      nonTarget: non.length,
      nonTargetSame: non.filter((r) => r.hash === r0[r.name].hash).length,
      nonTargetBiasSteps: sum(non.map((r) => r.biasSteps)),
      target: tgt.length,
      targetDiffer: tgt.filter((r) => r.hash !== r0[r.name].hash).length,
      targetBiasEver: tgt.filter((r) => r.biasEver).length,
      targetDifferWithoutBias: tgt.filter((r) => r.hash !== r0[r.name].hash && !r.biasEver).map((r) => r.name),
    };
  }
  iso.hookChecks = Object.fromEntries(BS.map((b) => [b, { natMismatch: sum(sums[b].runs.map((r) => r.natMismatch)), psiMismatch: sum(sums[b].runs.map((r) => r.psiMismatch)), steerWhileConfirmed: sum(sums[b].runs.map((r) => r.steerWhileConfirmed)), hookCalls: sum(sums[b].runs.map((r) => r.hookCalls)) }]));
}

// ---------- 读取逐步轨迹 ----------
function load(b, name) {
  const txt = gunzipSync(readFileSync(`${DIR}/b${b}/track/${name.replace(/[^\w.-]+/g, '_')}.csv.gz`)).toString();
  const lines = txt.split('\n');
  const head = lines[0].split(',');
  const cols = Object.fromEntries(head.map((h, i) => [h, new Float64Array(lines.length - 1)]));
  for (let k = 1; k < lines.length; k++) {
    const v = lines[k].split(',');
    for (let i = 0; i < head.length; i++) cols[head[i]][k - 1] = v[i] === '' ? NaN : +v[i];
  }
  cols.n = lines.length - 1;
  return cols;
}

// ---------- 2. 每场：五段链、窗口、安全、能量 ----------
const per = {}; // per[b][name] = {...}
for (const b of BS) {
  per[b] = {};
  for (const run of sums[b].runs.filter((r) => r.nn)) {
    const T = load(b, run.name);
    const n = T.n;
    const out = { name: run.name, beys: [] };
    for (const i of [0, 1]) {
      const s = run.spinSign[i];
      const g = (k) => T[`${k}${i}`];
      const gate = g('gate');
      const ring = { ratio: [], cosCmd: [], cosTarget: [], azErr: [], cosTilt: [], cosRel: [], relMag: [], upMag: [], nMag: [], cosFric: [], fDotT: 0, fAbs: 0, vDotT: [], cosV: [], speed: [], power: [], spin: [], t: [] };
      for (let k = 0; k < n; k++) {
        if (gate[k] !== 1) continue;
        const tx = g('tx')[k];
        const tz = g('tz')[k];
        ring.ratio.push(g('ratio')[k]);
        ring.cosCmd.push(g('cosD')[k]);
        const p = g('prec')[k];
        ring.cosTarget.push(s * (-Math.sin(p) * tx + Math.cos(p) * tz));
        const ux = g('upX')[k];
        const uz = g('upZ')[k];
        const uh = Math.hypot(ux, uz);
        if (uh > 1e-9) {
          ring.azErr.push(Math.abs(wrap(Math.atan2(uz, ux) - p)));
          ring.cosTilt.push((s * (-uz * tx + ux * tz)) / uh);
        }
        if (g('kind')[k] === 1 && Number.isFinite(g('nX')[k])) {
          const rx = ux - g('nX')[k];
          const rz = uz - g('nZ')[k];
          const rm = Math.hypot(rx, rz);
          ring.relMag.push(rm);
          ring.upMag.push(uh);
          ring.nMag.push(Math.hypot(g('nX')[k], g('nZ')[k]));
          if (rm > 1e-9) ring.cosRel.push((s * (-rz * tx + rx * tz)) / rm);
          const fx = g('fX')[k];
          const fz = g('fZ')[k];
          const fm = Math.hypot(fx, fz);
          if (fm > 0) {
            ring.cosFric.push((fx * tx + fz * tz) / fm);
            ring.fDotT += fx * tx + fz * tz;
            ring.fAbs += fm;
          }
          ring.power.push((fx * g('vx')[k] + fz * g('vz')[k]) * HZ);
        }
        const vx = g('vx')[k];
        const vz = g('vz')[k];
        const sp = Math.hypot(vx, vz);
        ring.vDotT.push(vx * tx + vz * tz);
        if (sp > 1e-4) ring.cosV.push((vx * tx + vz * tz) / sp);
        ring.speed.push(sp);
        ring.spin.push(g('spin')[k]);
        ring.t.push(k / HZ);
      }
      // 10 s 窗口：每个门控段起点
      const wins = run.segments.map((seg) => {
        const s0 = seg.start;
        const s1 = Math.min(n, s0 + WIN);
        let path = 0;
        let low = 0;
        let maxSp = 0;
        let maxR = 0;
        let recontact = -1;
        let towardOpp = 0;
        for (let k = s0; k < s1; k++) {
          if (k > s0) path += Math.hypot(g('px')[k] - g('px')[k - 1], g('pz')[k] - g('pz')[k - 1]);
          const sa = Math.hypot(T.vx0[k], T.vz0[k]);
          const sb = Math.hypot(T.vx1[k], T.vz1[k]);
          if (T.miss[k] > 6 && sa < 0.4 && sb < 0.4 && T.spin0[k] > 10 && T.spin1[k] > 10) low++;
          maxSp = Math.max(maxSp, Math.hypot(g('vx')[k], g('vz')[k]));
          maxR = Math.max(maxR, Math.hypot(g('px')[k], g('pz')[k]));
          if (recontact < 0 && k > s0 && T.miss[k] === 0) recontact = (k - s0) / HZ;
        }
        const net = Math.hypot(g('px')[s1 - 1] - g('px')[s0], g('pz')[s1 - 1] - g('pz')[s0]);
        const d0 = Math.hypot(T.px1[s0] - T.px0[s0], T.pz1[s0] - T.pz0[s0]);
        const d1 = Math.hypot(T.px1[s1 - 1] - T.px0[s1 - 1], T.pz1[s1 - 1] - T.pz0[s1 - 1]);
        towardOpp = d0 - d1;
        const sp0 = g('spin')[s0];
        return { start: s0, len: (s1 - s0) / HZ, segDur: (seg.end - seg.start) / HZ, exit: seg.exit, net, path, straight: path > 1e-9 ? net / path : 0, lowShare: low / (s1 - s0), recontact, maxSpeed: maxSp, maxR, distStart: d0, distEnd: d1, closed: towardOpp, spinLoss: (sp0 - g('spin')[s1 - 1]) / sp0 };
      });
      // 安全（门控 / 偏置窗口及之后 10 s）
      let maxTiltW = 0;
      let maxRW = 0;
      let wallW = 0;
      for (const seg of run.segments)
        for (let k = seg.start; k < Math.min(n, seg.end + WIN); k++) {
          maxTiltW = Math.max(maxTiltW, g('tilt')[k]);
          const r = Math.hypot(g('px')[k], g('pz')[k]);
          maxRW = Math.max(maxRW, r);
          if (r >= 4.32) wallW++;
        }
      // 能量：门控中转速线性回归斜率（rad/s 每秒）、转动动能损失率、推断摩擦对平动的功率
      const fitSlope = (ts, ys) => {
        const mt = mean(ts);
        const my = mean(ys);
        let a = 0;
        let c = 0;
        for (let k = 0; k < ts.length; k++) {
          a += (ts[k] - mt) * (ys[k] - my);
          c += (ts[k] - mt) ** 2;
        }
        return c > 0 ? a / c : NaN;
      };
      // 第一段前 10 s（三组起点状态相同 → 配对）
      const seg0 = run.segments[0];
      const ts0 = [];
      const ys0 = [];
      for (let k = seg0.start; k < Math.min(seg0.end, seg0.start + WIN); k++) {
        ts0.push(k / HZ);
        ys0.push(g('spin')[k]);
      }
      const I = run.inertia[i];
      const slope0 = fitSlope(ts0, ys0);
      out.beys.push({
        spinSign: s,
        gateSteps: ring.ratio.length,
        ring: {
          ratio: { p10: q(ring.ratio, 0.1), p50: q(ring.ratio, 0.5), p90: q(ring.ratio, 0.9), min: Math.min(...ring.ratio), max: Math.max(...ring.ratio) },
          cosCmd: mean(ring.cosCmd),
          cosTarget: mean(ring.cosTarget),
          azErrP50: deg(q(ring.azErr, 0.5)),
          azErrP90: deg(q(ring.azErr, 0.9)),
          cosTilt: mean(ring.cosTilt),
          cosRel: mean(ring.cosRel),
          relMagP50: q(ring.relMag, 0.5),
          upMagP50: q(ring.upMag, 0.5),
          nMagP50: q(ring.nMag, 0.5),
          cosFric: mean(ring.cosFric),
          fricPosShare: ring.cosFric.length ? ring.cosFric.filter((x) => x > 0).length / ring.cosFric.length : NaN,
          fricBias: ring.fAbs > 0 ? ring.fDotT / ring.fAbs : NaN,
          vDotT: mean(ring.vDotT),
          cosV: mean(ring.cosV),
          speedP50: q(ring.speed, 0.5),
          speedP90: q(ring.speed, 0.9),
        },
        windows: wins,
        safety: { maxTiltWin: maxTiltW, maxRWin: maxRW, wallStepsWin: wallW, maxTiltMatch: run.safety.maxTilt[i], maxRMatch: run.safety.maxR[i], wallStepsMatch: run.safety.wallSteps[i], tiltOver11: run.safety.tiltOver11Steps[i], knockResyncs: run.knockResyncs[i] },
        energy: { spinSlopeFirst10s: slope0, rotKELossRateFirst10s: -I * ys0[0] * slope0, fricPowerMean: mean(ring.power), spinStart: ys0[0] },
      });
    }
    out.result = run.result;
    out.stop = run.stop;
    out.segments = run.segments;
    per[b][run.name] = out;
  }
}

// ---------- 3. 汇总 ----------
const names = Object.keys(per['0']);
const pull = (b, f) => names.flatMap((nm) => per[b][nm].beys.map((x) => f(x, per[b][nm])));
const agg = {};
const theory = (b) => (b > 0 ? (1 - Math.sqrt(1 - b * b)) / b : 0);
for (const b of BS) {
  const firstWin = pull(b, (x) => x.windows[0]);
  const allWin = pull(b, (x) => x.windows).flat();
  agg[b] = {
    theoryCosCmd: theory(+b),
    ring: Object.fromEntries(['cosCmd', 'cosTarget', 'cosTilt', 'cosRel', 'cosFric', 'fricPosShare', 'fricBias', 'vDotT', 'cosV', 'azErrP50', 'azErrP90', 'relMagP50', 'upMagP50', 'nMagP50', 'speedP50', 'speedP90'].map((k) => {
      const a = pull(b, (x) => x.ring[k]).filter(Number.isFinite);
      return [k, { mean: mean(a), se: se(a), n: a.length }];
    })),
    ratio: { p10: mean(pull(b, (x) => x.ring.ratio.p10)), p50: mean(pull(b, (x) => x.ring.ratio.p50)), p90: mean(pull(b, (x) => x.ring.ratio.p90)), min: Math.min(...pull(b, (x) => x.ring.ratio.min)), max: Math.max(...pull(b, (x) => x.ring.ratio.max)) },
    firstWindow: {
      netP50: q(firstWin.map((w) => w.net), 0.5),
      netP90: q(firstWin.map((w) => w.net), 0.9),
      straightP50: q(firstWin.map((w) => w.straight), 0.5),
      lowShareMean: mean(firstWin.map((w) => w.lowShare)),
      recontactRate: firstWin.filter((w) => w.recontact >= 0).length / firstWin.length,
      recontactP50: q(firstWin.filter((w) => w.recontact >= 0).map((w) => w.recontact), 0.5),
      closedMean: mean(firstWin.map((w) => w.closed)),
      maxSpeed: Math.max(...firstWin.map((w) => w.maxSpeed)),
      maxSpeedP50: q(firstWin.map((w) => w.maxSpeed), 0.5),
      maxR: Math.max(...firstWin.map((w) => w.maxR)),
      spinLossMean: mean(firstWin.map((w) => w.spinLoss)),
      segDurP50: q(firstWin.map((w) => w.segDur), 0.5),
      segDurP90: q(firstWin.map((w) => w.segDur), 0.9),
      exits: firstWin.reduce((m, w) => ((m[w.exit] = (m[w.exit] ?? 0) + 1), m), {}),
    },
    allWindows: { n: allWin.length, netP50: q(allWin.map((w) => w.net), 0.5), netP90: q(allWin.map((w) => w.net), 0.9), recontactRate: allWin.filter((w) => w.recontact >= 0).length / allWin.length },
    segments: {
      perRun: names.map((nm) => per[b][nm].segments.length),
      total: sum(names.map((nm) => per[b][nm].segments.length)),
      shortUnder05s: sum(names.map((nm) => per[b][nm].segments.filter((s) => (s.end - s.start) / HZ < 0.5).length)),
      minGapS: Math.min(...names.flatMap((nm) => per[b][nm].segments.slice(1).map((s, k) => (s.start - per[b][nm].segments[k].end) / HZ))),
    },
    safety: {
      maxTiltWin: Math.max(...pull(b, (x) => x.safety.maxTiltWin)),
      maxRWin: Math.max(...pull(b, (x) => x.safety.maxRWin)),
      wallStepsWin: sum(pull(b, (x) => x.safety.wallStepsWin)),
      maxTiltMatch: Math.max(...pull(b, (x) => x.safety.maxTiltMatch)),
      maxRMatch: Math.max(...pull(b, (x) => x.safety.maxRMatch)),
      wallStepsMatch: sum(pull(b, (x) => x.safety.wallStepsMatch)),
      tiltOver11: sum(pull(b, (x) => x.safety.tiltOver11)),
      knockResyncs: sum(pull(b, (x) => x.safety.knockResyncs)),
      outs: names.filter((nm) => /over|xtreme/.test(per[b][nm].result)).length,
      stops: names.filter((nm) => per[b][nm].stop).map((nm) => `${nm}: ${per[b][nm].stop}`),
      results: names.reduce((m, nm) => ((m[per[b][nm].result] = (m[per[b][nm].result] ?? 0) + 1), m), {}),
    },
    energy: {
      spinSlopeMean: mean(pull(b, (x) => x.energy.spinSlopeFirst10s)),
      rotKELossRateMean: mean(pull(b, (x) => x.energy.rotKELossRateFirst10s)),
      fricPowerMean: mean(pull(b, (x) => x.energy.fricPowerMean).filter(Number.isFinite)),
    },
  };
}

// 配对差（b − b0），按场景×陀螺（48 个样本），第一段起点状态相同
const paired = {};
for (const b of ['0.3', '0.6']) {
  const d = (f) => names.flatMap((nm) => [0, 1].map((i) => f(per[b][nm].beys[i]) - f(per['0'][nm].beys[i]))).filter(Number.isFinite);
  const pack = (a) => ({ mean: mean(a), se: se(a), pos: a.filter((x) => x > 0).length, n: a.length });
  paired[b] = {
    startSame: names.every((nm) => per[b][nm].segments[0].start === per['0'][nm].segments[0].start),
    cosCmd: pack(d((x) => x.ring.cosCmd)),
    cosTarget: pack(d((x) => x.ring.cosTarget)),
    cosTilt: pack(d((x) => x.ring.cosTilt)),
    azErrP50: pack(d((x) => x.ring.azErrP50)),
    cosRel: pack(d((x) => x.ring.cosRel)),
    cosFric: pack(d((x) => x.ring.cosFric)),
    fricBias: pack(d((x) => x.ring.fricBias)),
    vDotT: pack(d((x) => x.ring.vDotT)),
    cosV: pack(d((x) => x.ring.cosV)),
    net10: pack(d((x) => x.windows[0].net)),
    straight10: pack(d((x) => x.windows[0].straight)),
    lowShare10: pack(d((x) => x.windows[0].lowShare)),
    closed10: pack(d((x) => x.windows[0].closed)),
    segDur: pack(d((x) => x.windows[0].segDur)),
    spinSlope: pack(d((x) => x.energy.spinSlopeFirst10s)),
    spinLoss10: pack(d((x) => x.windows[0].spinLoss)),
    fricPower: pack(d((x) => x.energy.fricPowerMean)),
  };
}

writeFileSync(`${DIR}/eval.json`, JSON.stringify({ iso, agg, paired, per }, null, 1));
console.log(JSON.stringify({ iso, agg, paired }, null, 1));
