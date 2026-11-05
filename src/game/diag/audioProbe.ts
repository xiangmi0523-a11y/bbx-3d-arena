/**
 * 音频诊断探针（仅诊断构建）。
 *
 * 不修改 AudioFX：在 AudioContext 原型的 create* 方法外面包一层计数，
 * 原方法照常调用、参数与返回值原样传递，音效本身不变。
 *  - 按类型统计累计创建的节点数；
 *  - 振荡器 / 音频缓冲源（真正发声的源节点）在 start 时 +1、ended 事件时 -1，得到“当前正在播放的源节点数”；
 *  - 监听 AudioContext 的 statechange，记录 suspended / running / interrupted / closed 的切换时间。
 * 非源节点（增益、滤波等）结束后由浏览器回收，Web Audio 没有接口能查询其存活数量，只能给累计创建数。
 */

export interface AudioEvent {
  /** performance.now()，ms */
  at: number;
  state: string;
}

export interface AudioProbeState {
  installed: boolean;
  contexts: number;
  /** 最近创建的 AudioContext（只读取状态，不操作） */
  ctx: BaseAudioContext | null;
  created: Record<string, number>;
  /** 已 start 且尚未 ended 的源节点数 */
  liveSources: number;
  peakLiveSources: number;
  sourcesStarted: number;
  sourcesEnded: number;
  stateEvents: AudioEvent[];
  onState: ((e: AudioEvent) => void) | null;
}

export const audioProbe: AudioProbeState = {
  installed: false,
  contexts: 0,
  ctx: null,
  created: {},
  liveSources: 0,
  peakLiveSources: 0,
  sourcesStarted: 0,
  sourcesEnded: 0,
  stateEvents: [],
  onState: null,
};

const FACTORIES = [
  'createOscillator',
  'createBufferSource',
  'createGain',
  'createBiquadFilter',
  'createWaveShaper',
  'createDynamicsCompressor',
  'createBuffer',
  'createConstantSource',
  'createPanner',
  'createStereoPanner',
  'createDelay',
  'createConvolver',
  'createAnalyser',
] as const;

const SOURCES = new Set(['createOscillator', 'createBufferSource', 'createConstantSource']);

function trackContext(ctx: BaseAudioContext): void {
  if (audioProbe.ctx === ctx) return;
  audioProbe.ctx = ctx;
  audioProbe.contexts++;
  const push = () => {
    const e = { at: performance.now(), state: ctx.state as string };
    audioProbe.stateEvents.push(e);
    if (audioProbe.stateEvents.length > 500) audioProbe.stateEvents.shift();
    audioProbe.onState?.(e);
  };
  push();
  ctx.addEventListener('statechange', push);
}

export function installAudioProbe(): void {
  if (audioProbe.installed || typeof window === 'undefined') return;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return;
  const proto = Ctor.prototype as unknown as Record<string, unknown>;
  // create* 定义在 BaseAudioContext.prototype 上；在子类原型上加一层同名包装即可
  for (const name of FACTORIES) {
    const orig = proto[name];
    if (typeof orig !== 'function') continue;
    const isSource = SOURCES.has(name);
    const wrapped = function (this: BaseAudioContext, ...args: unknown[]) {
      trackContext(this);
      const node = (orig as (...a: unknown[]) => unknown).apply(this, args);
      audioProbe.created[name] = (audioProbe.created[name] ?? 0) + 1;
      if (isSource && node) {
        const src = node as AudioScheduledSourceNode;
        const start = src.start;
        let started = false;
        src.start = function (...a: Parameters<AudioScheduledSourceNode['start']>) {
          if (!started) {
            started = true;
            audioProbe.sourcesStarted++;
            audioProbe.liveSources++;
            if (audioProbe.liveSources > audioProbe.peakLiveSources) audioProbe.peakLiveSources = audioProbe.liveSources;
          }
          return start.apply(this, a);
        };
        src.addEventListener('ended', () => {
          if (!started) return;
          started = false;
          audioProbe.sourcesEnded++;
          audioProbe.liveSources = Math.max(0, audioProbe.liveSources - 1);
        });
      }
      return node;
    };
    try {
      Object.defineProperty(proto, name, { value: wrapped, configurable: true, writable: true });
    } catch {
      /* 个别浏览器不允许改原型：放弃该项统计，不影响游戏 */
    }
  }
  audioProbe.installed = true;
}

export function audioSnapshot() {
  const p = audioProbe;
  const created = { ...p.created };
  const totalCreated = Object.entries(created)
    .filter(([k]) => k !== 'createBuffer')
    .reduce((a, [, v]) => a + v, 0);
  const ctx = p.ctx as (BaseAudioContext & { baseLatency?: number; outputLatency?: number }) | null;
  return {
    probeInstalled: p.installed,
    contextCount: p.contexts,
    contextState: ctx ? (ctx.state as string) : 'not-created',
    sampleRateHz: ctx?.sampleRate ?? null,
    baseLatencyMs: ctx?.baseLatency != null ? ctx.baseLatency * 1000 : null,
    outputLatencyMs: ctx?.outputLatency != null ? ctx.outputLatency * 1000 : null,
    /** 累计创建的音频节点数（按创建方法；不含 AudioBuffer 数据对象） */
    nodesCreatedTotal: totalCreated,
    nodesCreatedByType: created,
    /** 当前正在播放的源节点数（振荡器 / 缓冲源） */
    liveSourceNodes: p.liveSources,
    peakLiveSourceNodes: p.peakLiveSources,
    sourcesStarted: p.sourcesStarted,
    sourcesEnded: p.sourcesEnded,
  };
}
