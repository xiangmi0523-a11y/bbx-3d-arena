/**
 * Web Audio 桩：记录节点创建、播放源的开始 / 结束时间，用来验证音源生命周期和数量上限。
 * currentTime 由测试推进（advance），与模拟时间同步。
 */
class Param {
  value = 0;
  events = 0;
  setValueAtTime(v: number) { this.value = v; this.events++; return this; }
  linearRampToValueAtTime(v: number) { this.value = v; this.events++; return this; }
  exponentialRampToValueAtTime(v: number) { this.value = v; this.events++; return this; }
  setTargetAtTime(v: number) { this.value = v; this.events++; return this; }
  cancelScheduledValues() { return this; }
}

export class MockAudioContext {
  static last: MockAudioContext | null = null;
  currentTime = 0;
  state: string = 'running';
  sampleRate = 48000;
  destination = { connect() {} };
  created = 0;
  /** 已开始、尚未到停止时间（或没有停止）的播放源 */
  readonly sources = new Set<MockSource>();
  maxLiveSources = 0;
  constructor() {
    MockAudioContext.last = this;
  }
  resume() { this.state = 'running'; return Promise.resolve(); }
  advance(dt: number) {
    this.currentTime += dt;
    for (const s of this.sources) {
      if (s.stopAt !== null && s.stopAt <= this.currentTime) {
        this.sources.delete(s);
        s.onended?.();
      }
    }
  }
  get liveSources() { return this.sources.size; }
  private node<T extends object>(extra: T) {
    this.created++;
    return Object.assign(
      {
        connect: (d: unknown) => d,
        disconnect() {},
      },
      extra,
    );
  }
  createGain() { return this.node({ gain: new Param() }); }
  createBiquadFilter() { return this.node({ type: 'lowpass', frequency: new Param(), Q: new Param() }); }
  createDynamicsCompressor() { return this.node({ threshold: new Param(), ratio: new Param() }); }
  createWaveShaper() { return this.node({ curve: null as unknown }); }
  createBuffer(_c: number, len: number) { return { getChannelData: () => new Float32Array(len) }; }
  createOscillator() { return this.source({ type: 'sine', frequency: new Param() }); }
  createBufferSource() { return this.source({ buffer: null as unknown, loop: false }); }
  private source<T extends object>(extra: T) {
    const ctx = this;
    const s = this.node({
      ...extra,
      stopAt: null as number | null,
      onended: null as null | (() => void),
      start(when?: number, _offset?: number, duration?: number) {
        if (duration !== undefined) (s as unknown as MockSource).stopAt = (when ?? ctx.currentTime) + duration;
        ctx.sources.add(s as unknown as MockSource);
        ctx.maxLiveSources = Math.max(ctx.maxLiveSources, ctx.sources.size);
      },
      stop(t?: number) {
        (s as unknown as MockSource).stopAt = t ?? ctx.currentTime;
      },
    });
    return s;
  }
}
type MockSource = { stopAt: number | null; onended: null | (() => void) };

/**
 * 用 Web Audio 桩解锁 AudioFX。只在 unlock() 期间临时挂 window.AudioContext，随后删掉：
 * 全局 window 存在时 Rapier 的 wasm 胶水代码会走浏览器分支，在 Node 里直接崩溃。
 */
export function unlockWithMock(audio: { unlock(): void }): MockAudioContext {
  const g = globalThis as unknown as { window?: Record<string, unknown> };
  const had = 'window' in g;
  g.window ??= {};
  g.window.AudioContext = MockAudioContext;
  try {
    audio.unlock();
  } finally {
    if (!had) delete g.window;
  }
  return MockAudioContext.last!;
}
