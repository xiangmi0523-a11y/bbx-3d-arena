/**
 * 两次记录的逐场对照：先比较各通道全程哈希，不一致时找第一个不同的块（定位到 chunkSteps 步内），
 * 并给出该块开始时关键帧的最大偏差、第一处不同的事件和终局。只比较，不放宽任何标准：浮点逐位相同才算一致。
 */
import { CHANNELS, type BeyState, type Channel, type Trace } from './recorder';

/** 写进 golden 文件的每场摘要（不含关键帧与事件明细） */
export interface TraceSummary {
  name: string;
  seed: number;
  steps: number;
  config: string;
  final: Record<Channel, string>;
  result: Trace['result'];
  counters: Trace['counters'];
}

export function summarize(t: Trace): TraceSummary {
  return { name: t.name, seed: t.seed, steps: t.steps, config: t.config, final: t.final, result: t.result, counters: t.counters };
}

export interface RunDiff {
  name: string;
  channels: Channel[];
  /** 第一个不同的块与对应步区间 */
  firstChunk: { channel: Channel; chunk: number; steps: [number, number] } | null;
  /** 该块开始时关键帧的最大绝对偏差（两边都有关键帧时） */
  keyframeMaxDelta: number | null;
  firstEventDiff: { index: number; a: unknown; b: unknown } | null;
  steps: [number, number];
  result: [unknown, unknown];
  config: [string, string];
}

export interface CompareReport {
  total: number;
  missing: string[];
  identical: number;
  channelIdentical: Record<Channel, number>;
  resultIdentical: number;
  diffs: RunDiff[];
}

const flat = (s: BeyState) => [...s.p, ...s.q, ...s.v, ...s.w, s.spin, s.tilt, s.heading, s.authority, s.breakout];

export function compareTraces(a: (Trace | TraceSummary)[], b: (Trace | TraceSummary)[]): CompareReport {
  const mb = new Map(b.map((t) => [t.name, t]));
  const channelIdentical = Object.fromEntries(CHANNELS.map((c) => [c, 0])) as Record<Channel, number>;
  const diffs: RunDiff[] = [];
  const missing: string[] = [];
  let identical = 0;
  let resultIdentical = 0;
  for (const x of a) {
    const y = mb.get(x.name);
    if (!y) {
      missing.push(x.name);
      continue;
    }
    const bad = CHANNELS.filter((c) => x.final[c] !== y.final[c]);
    for (const c of CHANNELS) if (!bad.includes(c)) channelIdentical[c]++;
    const sameResult = JSON.stringify(x.result) === JSON.stringify(y.result) && x.steps === y.steps;
    if (sameResult) resultIdentical++;
    if (!bad.length && sameResult && x.config === y.config) {
      identical++;
      continue;
    }
    let firstChunk: RunDiff['firstChunk'] = null;
    let keyframeMaxDelta: number | null = null;
    let firstEventDiff: RunDiff['firstEventDiff'] = null;
    if ('chunks' in x && 'chunks' in y) {
      let best = Infinity;
      for (const c of bad) {
        const n = Math.max(x.chunks[c].length, y.chunks[c].length);
        for (let k = 0; k < n; k++)
          if (x.chunks[c][k] !== y.chunks[c][k]) {
            if (k < best) {
              best = k;
              firstChunk = { channel: c, chunk: k, steps: [k * x.chunkSteps, (k + 1) * x.chunkSteps] };
            }
            break;
          }
      }
      if (firstChunk && x.keyframes && y.keyframes) {
        const ka = x.keyframes[firstChunk.chunk];
        const kb = y.keyframes[firstChunk.chunk];
        if (ka && kb) {
          const fa = [...flat(ka.player), ...flat(ka.rival)];
          const fb = [...flat(kb.player), ...flat(kb.rival)];
          keyframeMaxDelta = Math.max(...fa.map((v, i) => Math.abs(v - fb[i])));
        }
      }
      const n = Math.max(x.events.length, y.events.length);
      for (let i = 0; i < n; i++)
        if (JSON.stringify(x.events[i]) !== JSON.stringify(y.events[i])) {
          firstEventDiff = { index: i, a: x.events[i] ?? null, b: y.events[i] ?? null };
          break;
        }
    }
    diffs.push({ name: x.name, channels: bad, firstChunk, keyframeMaxDelta, firstEventDiff, steps: [x.steps, y.steps], result: [x.result, y.result], config: [x.config, y.config] });
  }
  return { total: a.length, missing, identical, channelIdentical, resultIdentical, diffs };
}
