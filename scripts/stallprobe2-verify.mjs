// 探针 V2 跨树基线对照：本分支探针运行（runs.*.json）与干净 cb4c2c4 工作树无探针运行（plain-*.json）逐场比对。
//   node scripts/stallprobe2-verify.mjs <探针 runs.json> <基线 plain.json> <输出 verify.json>
import { readFileSync, writeFileSync } from 'node:fs';

const [probeF, plainF, outF] = process.argv.slice(2);
const probe = JSON.parse(readFileSync(probeF, 'utf8'));
const plain = JSON.parse(readFileSync(plainF, 'utf8'));
const base = new Map(plain.runs.map((r) => [r.name, r]));
const rows = probe.runs.map((r) => {
  const p = base.get(r.name);
  return {
    name: r.name,
    seed: r.seed,
    probeHash: r.hash,
    baselineHash: p?.hash ?? null,
    steps: [r.steps, p?.steps ?? null],
    result: [r.result, p?.result ?? null],
    breakouts: [r.breakouts, p?.breakouts ?? null],
    wobbleBreaks: [r.wobbleBreaks, p?.wobbleBreaks ?? null],
    same: !!p && p.hash === r.hash && p.steps === r.steps && p.result === r.result,
  };
});
const missing = plain.runs.filter((r) => !probe.runs.some((x) => x.name === r.name)).map((r) => r.name);
const out = {
  baselineHead: plain.head,
  baselineTrackedDirty: plain.trackedDirty,
  tune: [probe.tune, plain.tune],
  total: rows.length,
  same: rows.filter((r) => r.same).length,
  differ: rows.filter((r) => !r.same).map((r) => r.name),
  missingInProbe: missing,
  rows,
};
writeFileSync(outF, JSON.stringify(out, null, 1));
console.log(`${probeF} vs ${plainF}: ${out.same}/${out.total} 一致；不一致 ${out.differ.length}；基线 ${plain.head} 已跟踪文件改动 ${plain.trackedDirty ? '有' : '无'}`);
