/**
 * Stage 0 逐帧性能记录器（仅诊断构建）。
 *
 * GameEngine.frame() 在 `if (DIAG)` 分支里调用 skip / begin / end，记录器只读游戏已有的分段计时累加器
 * （GameEngine.perf）和 renderer.info，不改变游戏逻辑、画质或渲染。
 *
 * 每个“渲染帧”（通过 60fps 上限、真正执行了 tick + render 的 rAF 回调）记录一行：
 *  - interval：与上一渲染帧的 rAF 时间戳之差（ms）
 *  - frameCpu：本帧回调里可测量的 JS 主线程耗时（ms），再细分为 tick 内各段与 renderer.render 的 CPU 提交
 *  - unattributed：interval − 上一帧 frameCpu。包括 GPU 执行与等待、合成、WebView/系统调度、
 *    React 等回调之外的 JS 任务、GC 等，浏览器无法区分，统一记为
 *    “unattributed render/composition/system scheduling”，不当作 GPU 耗时。
 * 列数据存放在预分配的 Float32Array 里（记录开始时分配），记录期间不产生垃圾对象。
 */
import type * as THREE from 'three';
import { audioProbe, audioSnapshot } from './audioProbe';
import { BUILD_INFO } from './flag';
import { dist, FULL_FRAME_MS, FULL_FRAME_TOL_MS, histogram, longFrames, ratioAtMost, timerResolutionMs, type Dist } from './stats';

/** 与 GameEngine.perf 一致的累加器字段（毫秒累计 / 步数累计） */
export interface EnginePerfAcc {
  tick: number;
  render: number;
  physics: number;
  physSteps: number;
  sync: number;
  fx: number;
  cam: number;
  ui: number;
}

export interface DiagContext {
  renderer: THREE.WebGLRenderer;
  quality: () => { level: string; locked: boolean };
  shadowMapSize: () => number;
}

export const PHASES = ['loading', 'title', 'garage', 'aim', 'battle', 'paused', 'result', 'error'] as const;
export const QUALITIES = ['low', 'medium', 'high', 'ultra'] as const;

/** 列名与单位（CSV 表头 / JSON 说明共用） */
export const COLUMNS = [
  ['t_ms', 'ms', '本帧 rAF 时间戳，从记录开始算'],
  ['interval_ms', 'ms', '与上一渲染帧的间隔'],
  ['raf_skipped', 'count', '本帧之前被 60fps 上限跳过的 rAF 回调数（120Hz 屏幕上通常为 1）'],
  ['frame_cpu_ms', 'ms', '本帧回调内可测量的 CPU 总耗时 = tick + render_submit + frame_other'],
  ['tick_ms', 'ms', 'GameEngine.tick 总耗时（游戏更新）'],
  ['physics_ms', 'ms', 'Rapier 物理步进 PhysicsWorld.advance'],
  ['phys_steps', 'count', '本帧物理步数（120Hz 固定步长）'],
  ['sync_ms', 'ms', '撞击反馈派发 + 物理→模型同步'],
  ['fx_ms', 'ms', '特效更新 ImpactFX.update'],
  ['cam_ms', 'ms', '镜头更新 BattleCamera.update'],
  ['ui_ms', 'ms', 'HUD 状态推送 store.set（React 重渲染在回调外，不在此列）'],
  ['tick_other_ms', 'ms', 'tick 内未细分部分（瞄准阶段动画等）'],
  ['render_submit_ms', 'ms', 'renderer.render 的 CPU 耗时（场景遍历 + WebGL 指令提交，含阴影 pass；不是 GPU 耗时）'],
  ['frame_other_ms', 'ms', '回调内其余部分（帧率统计、画质采样、组装界面帧的 update+render）'],
  ['unattributed_ms', 'ms', 'unattributed render/composition/system scheduling = interval − 上一帧 frame_cpu'],
  ['draw_calls', 'count', 'renderer.info.render.calls（本帧，含阴影 pass）'],
  ['triangles', 'count', 'renderer.info.render.triangles（本帧，含阴影 pass）'],
  ['pixel_ratio', 'x', 'renderer.getPixelRatio()'],
  ['quality', 'enum', '画质档位 low/medium/high/ultra'],
  ['shadows', 'bool', 'renderer.shadowMap.enabled'],
  ['phase', 'enum', '游戏阶段'],
  ['audio_live_sources', 'count', '正在播放的音频源节点数'],
  ['diag_ms', 'ms', '记录器自身在本帧的耗时（诊断开销自测）'],
] as const;

type Col = (typeof COLUMNS)[number][0];
// 用 PURE 标注：非诊断构建不引用记录器时，打包器能把整个模块删干净
const COL_INDEX = /* @__PURE__ */ buildIndex();
const NCOL = /* @__PURE__ */ columnCount();
function buildIndex(): Record<Col, number> {
  return Object.fromEntries(COLUMNS.map(([k], i) => [k, i])) as Record<Col, number>;
}
function columnCount(): number {
  return COLUMNS.length;
}

export interface DiagEvent {
  /** 从记录开始算，ms */
  tMs: number;
  type: 'phase' | 'quality' | 'pixelRatio' | 'shadows' | 'visibility' | 'audioState' | 'pagehide' | 'pageshow' | 'bufferFull' | 'note';
  value: string;
}

export interface SegmentStats {
  unit: 'ms/frame';
  frameCpu: Dist;
  tick: Dist;
  physics: Dist;
  sync: Dist;
  fx: Dist;
  cam: Dist;
  ui: Dist;
  tickOther: Dist;
  renderSubmit: Dist;
  frameOther: Dist;
  unattributed: Dist;
  diagOverhead: Dist;
  physStepsPerFrame: Dist;
  /** 平均 frameCpu / 平均帧间隔（0..1） */
  cpuShareOfInterval: number;
}

export interface FrameSummary {
  frames: number;
  durationS: number;
  intervalP50: number;
  intervalP95: number;
  intervalP99: number;
  /** 最长帧间隔（ms） */
  maxFrameMs: number;
  /** 最长单帧可测 CPU 耗时（ms；对应原 PerfBadge 的“最长逻辑+提交”） */
  maxFrameCpuMs: number;
  intervalMeanMs: number;
  /** 平均帧率 = 帧数 / 时长（fps） */
  avgFps: number;
  longFrames: ReturnType<typeof longFrames>;
  /** 帧间隔 ≤ 16.7 ms 的比例（0..1） */
  ratioAtMost16_7ms: number;
  /** 帧间隔 ≤ 18 ms 的比例（0..1；含 vsync 抖动容差，仅辅助参考） */
  ratioAtMost18ms: number;
  histogram: ReturnType<typeof histogram>;
  cpu: SegmentStats;
  render: {
    drawCalls: Dist;
    triangles: Dist;
    pixelRatios: number[];
    qualities: string[];
    shadowsOnRatio: number;
  };
  audioLiveSources: Dist;
}

const CAPACITY = 54000; // 60fps 下约 15 分钟

export class PerfRecorder {
  ctx: DiagContext | null = null;
  recording = false;
  /** 自动停止时长（ms），0 = 手动停止 */
  autoStopMs = 0;
  onAutoStop: (() => void) | null = null;

  private cols: Float32Array[] = [];
  private n = 0;
  private startNow = 0;
  private stopNow = 0;
  private startWall = '';
  private lastFrameNow = -1;
  private prevFrameCpu = NaN;
  private skipped = 0;
  private rafTotal = 0;
  private overheadSum = 0;
  private snap = new Float64Array(8);
  private tBegin = 0;
  private interval = 0;
  private lastPhase = -1;
  private lastQuality = -1;
  private lastPr = -1;
  private lastShadows = -1;
  private events: DiagEvent[] = [];
  private timerRes = 0;
  private audioAtStart: ReturnType<typeof audioSnapshot> | null = null;
  private audioAtStop: ReturnType<typeof audioSnapshot> | null = null;
  private peakLiveAtStart = 0;
  private listening = false;

  attach(ctx: DiagContext): void {
    this.ctx = ctx;
  }

  get frames(): number {
    return this.n;
  }

  get elapsedMs(): number {
    if (!this.startNow) return 0;
    return (this.recording ? performance.now() : this.stopNow) - this.startNow;
  }

  start(autoStopSeconds = 0): void {
    if (!this.cols.length) this.cols = Array.from({ length: NCOL }, () => new Float32Array(CAPACITY));
    this.n = 0;
    this.events = [];
    this.timerRes = timerResolutionMs();
    this.startNow = performance.now();
    this.stopNow = 0;
    this.startWall = new Date().toISOString();
    this.lastFrameNow = -1;
    this.prevFrameCpu = NaN;
    this.skipped = 0;
    this.rafTotal = 0;
    this.overheadSum = 0;
    this.lastPhase = this.lastQuality = this.lastPr = this.lastShadows = -1;
    this.autoStopMs = autoStopSeconds * 1000;
    this.audioAtStart = audioSnapshot();
    this.peakLiveAtStart = audioProbe.liveSources;
    audioProbe.peakLiveSources = audioProbe.liveSources;
    this.audioAtStop = null;
    this.listen();
    this.recording = true;
    this.event('note', `start autoStop=${autoStopSeconds}s`);
  }

  stop(reason = 'manual'): void {
    if (!this.recording) return;
    this.recording = false;
    this.stopNow = performance.now();
    this.event('note', `stop ${reason}`);
    this.audioAtStop = audioSnapshot();
  }

  event(type: DiagEvent['type'], value: string): void {
    if (!this.startNow) return;
    this.events.push({ tMs: round3(performance.now() - this.startNow), type, value });
  }

  private listen(): void {
    if (this.listening || typeof document === 'undefined') return;
    this.listening = true;
    document.addEventListener('visibilitychange', () => this.recording && this.event('visibility', document.visibilityState));
    window.addEventListener('pagehide', () => this.recording && this.event('pagehide', ''));
    window.addEventListener('pageshow', () => this.recording && this.event('pageshow', ''));
    audioProbe.onState = (e) => this.recording && this.event('audioState', e.state);
  }

  // ───────────── 由 GameEngine.frame() 调用 ─────────────

  /** rAF 回调被 60fps 上限跳过 */
  skip(): void {
    if (!this.recording) return;
    this.skipped++;
    this.rafTotal++;
  }

  /** 渲染帧开始（已通过帧率上限判断） */
  begin(now: number, elapsed: number, perf: EnginePerfAcc): void {
    if (!this.recording) return;
    this.tBegin = performance.now();
    this.rafTotal++;
    this.interval = elapsed;
    const s = this.snap;
    s[0] = perf.tick;
    s[1] = perf.render;
    s[2] = perf.physics;
    s[3] = perf.physSteps;
    s[4] = perf.sync;
    s[5] = perf.fx;
    s[6] = perf.cam;
    s[7] = perf.ui;
    this.lastFrameNow = now;
  }

  /** 渲染帧结束（tick + render 都已完成） */
  end(perf: EnginePerfAcc, phase: string): void {
    if (!this.recording) return;
    const tEnd = performance.now();
    const ctx = this.ctx;
    if (this.n >= CAPACITY) {
      this.event('bufferFull', String(CAPACITY));
      this.stop('bufferFull');
      return;
    }
    const s = this.snap;
    const c = this.cols;
    const i = this.n;
    const frameCpu = tEnd - this.tBegin;
    const tick = perf.tick - s[0];
    const render = perf.render - s[1];
    const physics = perf.physics - s[2];
    const sync = perf.sync - s[4];
    const fx = perf.fx - s[5];
    const cam = perf.cam - s[6];
    const ui = perf.ui - s[7];
    c[COL_INDEX.t_ms][i] = this.lastFrameNow - this.startNow;
    c[COL_INDEX.interval_ms][i] = i === 0 ? NaN : this.interval;
    c[COL_INDEX.raf_skipped][i] = this.skipped;
    c[COL_INDEX.frame_cpu_ms][i] = frameCpu;
    c[COL_INDEX.tick_ms][i] = tick;
    c[COL_INDEX.physics_ms][i] = physics;
    c[COL_INDEX.phys_steps][i] = perf.physSteps - s[3];
    c[COL_INDEX.sync_ms][i] = sync;
    c[COL_INDEX.fx_ms][i] = fx;
    c[COL_INDEX.cam_ms][i] = cam;
    c[COL_INDEX.ui_ms][i] = ui;
    c[COL_INDEX.tick_other_ms][i] = Math.max(0, tick - physics - sync - fx - cam - ui);
    c[COL_INDEX.render_submit_ms][i] = render;
    c[COL_INDEX.frame_other_ms][i] = Math.max(0, frameCpu - tick - render);
    // 计时器粗化（iOS 约 1 ms）时差值可能为负，截到 0
    c[COL_INDEX.unattributed_ms][i] = i === 0 || Number.isNaN(this.prevFrameCpu) ? NaN : Math.max(0, this.interval - this.prevFrameCpu);
    this.skipped = 0;
    this.prevFrameCpu = frameCpu;

    const phaseCode = PHASES.indexOf(phase as (typeof PHASES)[number]);
    c[COL_INDEX.phase][i] = phaseCode;
    if (phaseCode !== this.lastPhase) {
      this.lastPhase = phaseCode;
      this.event('phase', phase);
    }
    c[COL_INDEX.audio_live_sources][i] = audioProbe.liveSources;
    if (ctx) {
      const info = ctx.renderer.info.render;
      c[COL_INDEX.draw_calls][i] = info.calls;
      c[COL_INDEX.triangles][i] = info.triangles;
      const pr = ctx.renderer.getPixelRatio();
      c[COL_INDEX.pixel_ratio][i] = pr;
      if (pr !== this.lastPr) {
        this.lastPr = pr;
        this.event('pixelRatio', String(pr));
      }
      const q = ctx.quality();
      const qc = QUALITIES.indexOf(q.level as (typeof QUALITIES)[number]);
      c[COL_INDEX.quality][i] = qc;
      if (qc !== this.lastQuality) {
        this.lastQuality = qc;
        this.event('quality', `${q.level}${q.locked ? ' (locked)' : ' (auto)'}`);
      }
      const sh = ctx.renderer.shadowMap.enabled ? 1 : 0;
      c[COL_INDEX.shadows][i] = sh;
      if (sh !== this.lastShadows) {
        this.lastShadows = sh;
        this.event('shadows', sh ? `on ${ctx.shadowMapSize()}px` : 'off');
      }
    }
    this.n++;
    const diag = performance.now() - tEnd;
    c[COL_INDEX.diag_ms][i] = diag;
    this.overheadSum += diag;
    if (this.autoStopMs > 0 && this.lastFrameNow - this.startNow >= this.autoStopMs) {
      this.stop('autoStop');
      this.onAutoStop?.();
    }
  }

  // ───────────── 统计与导出 ─────────────

  private col(name: Col, filter?: Uint8Array): Float32Array {
    const src = this.cols[COL_INDEX[name]].subarray(0, this.n);
    const out: number[] = [];
    for (let i = 0; i < src.length; i++) {
      if (filter && !filter[i]) continue;
      if (!Number.isNaN(src[i])) out.push(src[i]);
    }
    return Float32Array.from(out);
  }

  private summarize(filter?: Uint8Array): FrameSummary {
    const iv = this.col('interval_ms', filter);
    const t = this.col('t_ms', filter);
    // interval 列首帧为 NaN，时间戳与之对齐
    const tAligned = iv.length === t.length ? t : t.subarray(t.length - iv.length);
    let durationMs = 0;
    for (let k = 0; k < iv.length; k++) durationMs += iv[k];
    const d = dist(iv);
    const cpuDist = (name: Col) => dist(this.col(name, filter));
    const frameCpu = cpuDist('frame_cpu_ms');
    const prs = new Set<number>();
    const qs = new Set<string>();
    const prCol = this.col('pixel_ratio', filter);
    const qCol = this.col('quality', filter);
    const shCol = this.col('shadows', filter);
    for (let k = 0; k < prCol.length; k++) prs.add(round3(prCol[k]));
    for (let k = 0; k < qCol.length; k++) qs.add(QUALITIES[qCol[k]] ?? 'unknown');
    let shOn = 0;
    for (let k = 0; k < shCol.length; k++) shOn += shCol[k];
    return {
      frames: iv.length,
      durationS: durationMs / 1000,
      intervalP50: d.p50,
      intervalP95: d.p95,
      intervalP99: d.p99,
      maxFrameMs: d.max,
      maxFrameCpuMs: frameCpu.max,
      intervalMeanMs: d.mean,
      avgFps: durationMs > 0 ? (iv.length * 1000) / durationMs : 0,
      longFrames: longFrames(tAligned, iv, durationMs),
      ratioAtMost16_7ms: ratioAtMost(iv, FULL_FRAME_MS),
      ratioAtMost18ms: ratioAtMost(iv, FULL_FRAME_TOL_MS),
      histogram: histogram(iv),
      cpu: {
        unit: 'ms/frame',
        frameCpu,
        tick: cpuDist('tick_ms'),
        physics: cpuDist('physics_ms'),
        sync: cpuDist('sync_ms'),
        fx: cpuDist('fx_ms'),
        cam: cpuDist('cam_ms'),
        ui: cpuDist('ui_ms'),
        tickOther: cpuDist('tick_other_ms'),
        renderSubmit: cpuDist('render_submit_ms'),
        frameOther: cpuDist('frame_other_ms'),
        unattributed: cpuDist('unattributed_ms'),
        diagOverhead: cpuDist('diag_ms'),
        physStepsPerFrame: cpuDist('phys_steps'),
        cpuShareOfInterval: d.mean > 0 ? frameCpu.mean / d.mean : 0,
      },
      render: {
        drawCalls: cpuDist('draw_calls'),
        triangles: cpuDist('triangles'),
        pixelRatios: [...prs].sort(),
        qualities: [...qs],
        shadowsOnRatio: shCol.length ? shOn / shCol.length : 0,
      },
      audioLiveSources: cpuDist('audio_live_sources'),
    };
  }

  /** 摘要（不含逐帧数据） */
  summary() {
    const phaseCol = this.cols.length ? this.cols[COL_INDEX.phase].subarray(0, this.n) : new Float32Array();
    const battleIdx = PHASES.indexOf('battle');
    const battle = Uint8Array.from(phaseCol, (p) => (p === battleIdx ? 1 : 0));
    const framesByPhase: Record<string, number> = {};
    for (let i = 0; i < phaseCol.length; i++) {
      const k = PHASES[phaseCol[i]] ?? 'unknown';
      framesByPhase[k] = (framesByPhase[k] ?? 0) + 1;
    }
    const ctx = this.ctx;
    const r = ctx?.renderer;
    const gl = r?.getContext();
    const durationMs = this.elapsedMs;
    const q = ctx?.quality();
    return {
      schema: 'bbx-perf-diag/1',
      units: {
        time: 'ms',
        duration: 's',
        ratio: '0..1',
        fps: 'frames/s',
        drawCalls: 'count/frame',
        triangles: 'count/frame',
        pixelRatio: 'device px per CSS px',
        cpu: 'ms/frame',
      },
      build: { ...BUILD_INFO },
      recording: {
        startedAt: this.startWall,
        durationS: durationMs / 1000,
        /** 记录到的渲染帧（样本）数 */
        samples: this.n,
        rafCallbacks: this.rafTotal,
        /** rAF 回调频率估计（≈ 屏幕刷新率，Hz） */
        rafRateHz: durationMs > 0 ? (this.rafTotal * 1000) / durationMs : 0,
        framesByPhase,
        /** performance.now() 实测精度（ms）；iOS 上约 1 ms，单帧分段计时会量化，均值仍可参考 */
        timerResolutionMs: this.timerRes,
        recording: this.recording,
        /** 记录器自身耗时合计（ms）与每帧均值（ms/frame） */
        diagOverheadTotalMs: this.overheadSum,
        diagOverheadPerFrameMs: this.n ? this.overheadSum / this.n : 0,
      },
      device: {
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
        devicePixelRatio: typeof window !== 'undefined' ? window.devicePixelRatio : 0,
        screen: typeof screen !== 'undefined' ? { width: screen.width, height: screen.height } : null,
        viewport: typeof window !== 'undefined' ? { width: window.innerWidth, height: window.innerHeight } : null,
        hardwareConcurrency: typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 0,
      },
      renderState: r
        ? {
            pixelRatio: r.getPixelRatio(),
            drawingBuffer: gl ? { width: gl.drawingBufferWidth, height: gl.drawingBufferHeight } : null,
            msaaSamples: gl ? (gl.getParameter(gl.SAMPLES) as number) : null,
            shadowsEnabled: r.shadowMap.enabled,
            shadowMapSizePx: ctx!.shadowMapSize(),
            quality: q?.level ?? null,
            qualityMode: q ? (q.locked ? 'locked' : 'auto') : null,
            programs: r.info.programs?.length ?? null,
            geometries: r.info.memory.geometries,
            textures: r.info.memory.textures,
          }
        : null,
      audio: {
        atStart: this.audioAtStart,
        atStop: this.audioAtStop ?? audioSnapshot(),
        current: audioSnapshot(),
        peakLiveSourceNodesDuringRecording: Math.max(this.peakLiveAtStart, audioProbe.peakLiveSources),
        stateEvents: audioProbe.stateEvents.map((e) => ({ tMs: round3(e.at - this.startNow), state: e.state })),
      },
      all: this.summarize(),
      battleOnly: this.summarize(battle),
      events: this.events,
    };
  }

  /** 完整 JSON：摘要 + 逐帧数据（按列名的二维数组） */
  toJSON(includeFrames = true): string {
    const out: Record<string, unknown> = this.summary();
    if (includeFrames) {
      out.frames = {
        columns: COLUMNS.map(([k]) => k),
        units: Object.fromEntries(COLUMNS.map(([k, u]) => [k, u])),
        descriptions: Object.fromEntries(COLUMNS.map(([k, , d]) => [k, d])),
        rows: Array.from({ length: this.n }, (_, i) => COLUMNS.map((_c, j) => this.cell(j, i))),
      };
    }
    return JSON.stringify(out, (_k, v) => (typeof v === 'number' ? (Number.isFinite(v) ? round3(v) : null) : v));
  }

  private cell(j: number, i: number): number | string | null {
    const v = this.cols[j][i];
    const name = COLUMNS[j][0];
    if (name === 'phase') return PHASES[v] ?? 'unknown';
    if (name === 'quality') return QUALITIES[v] ?? 'unknown';
    return Number.isNaN(v) ? null : round3(v);
  }

  /** 逐帧 CSV（表头带单位） */
  toCSV(): string {
    const head = COLUMNS.map(([k]) => k).join(',');
    const units = COLUMNS.map(([, u]) => u).join(',');
    const lines = [`# build=${BUILD_INFO.sha} label=${BUILD_INFO.label} started=${this.startWall} samples=${this.n} durationS=${round3(this.elapsedMs / 1000)}`, `# units: ${units}`, head];
    for (let i = 0; i < this.n; i++) {
      const row: (string | number)[] = [];
      for (let j = 0; j < NCOL; j++) {
        const v = this.cell(j, i);
        row.push(v === null ? '' : v);
      }
      lines.push(row.join(','));
    }
    return lines.join('\n');
  }

  /** 摘要 CSV（一行一个指标：scope,metric,value,unit） */
  summaryCSV(): string {
    const s = this.summary();
    const rows: [string, string, number | string, string][] = [
      ['meta', 'build_sha', s.build.sha, ''],
      ['meta', 'duration', s.recording.durationS, 's'],
      ['meta', 'samples', s.recording.samples, 'frames'],
      ['meta', 'timer_resolution', s.recording.timerResolutionMs, 'ms'],
      ['meta', 'raf_rate', s.recording.rafRateHz, 'Hz'],
      ['meta', 'diag_overhead_per_frame', s.recording.diagOverheadPerFrameMs, 'ms/frame'],
    ];
    for (const scope of ['all', 'battleOnly'] as const) {
      const f = s[scope];
      rows.push(
        [scope, 'frames', f.frames, 'frames'],
        [scope, 'duration', f.durationS, 's'],
        [scope, 'avg_fps', f.avgFps, 'fps'],
        [scope, 'intervalP50', f.intervalP50, 'ms'],
        [scope, 'intervalP95', f.intervalP95, 'ms'],
        [scope, 'intervalP99', f.intervalP99, 'ms'],
        [scope, 'maxFrameMs', f.maxFrameMs, 'ms'],
        [scope, 'maxFrameCpuMs', f.maxFrameCpuMs, 'ms'],
        [scope, 'long_frames_gt33.4_total', f.longFrames.total, 'count'],
        [scope, 'long_frames_gt33.4_per60s', f.longFrames.per60s, 'count/60s'],
        [scope, 'long_frames_gt33.4_first60s', f.longFrames.first60s ?? '', 'count'],
        [scope, 'long_frames_gt33.4_worst60s', f.longFrames.worst60s ?? '', 'count'],
        [scope, 'ratio_interval_le_16.7ms', f.ratioAtMost16_7ms, '0..1'],
        [scope, 'ratio_interval_le_18ms', f.ratioAtMost18ms, '0..1'],
      );
      for (const b of f.histogram) rows.push([scope, `hist_${b.fromMs}-${b.toMs ?? 'inf'}ms`, b.count, 'frames']);
      for (const [k, v] of Object.entries(f.cpu)) {
        if (typeof v === 'object') rows.push([scope, `cpu_${k}_mean`, v.mean, k === 'physStepsPerFrame' ? 'steps/frame' : 'ms/frame'], [scope, `cpu_${k}_p95`, v.p95, k === 'physStepsPerFrame' ? 'steps/frame' : 'ms/frame'], [scope, `cpu_${k}_max`, v.max, k === 'physStepsPerFrame' ? 'steps/frame' : 'ms/frame']);
      }
      rows.push(
        [scope, 'cpu_share_of_interval', f.cpu.cpuShareOfInterval, '0..1'],
        [scope, 'draw_calls_mean', f.render.drawCalls.mean, 'count/frame'],
        [scope, 'draw_calls_max', f.render.drawCalls.max, 'count/frame'],
        [scope, 'triangles_mean', f.render.triangles.mean, 'count/frame'],
        [scope, 'triangles_max', f.render.triangles.max, 'count/frame'],
        [scope, 'pixel_ratios', f.render.pixelRatios.join('|'), 'x'],
        [scope, 'qualities', f.render.qualities.join('|'), 'enum'],
        [scope, 'shadows_on_ratio', f.render.shadowsOnRatio, '0..1'],
        [scope, 'audio_live_sources_mean', f.audioLiveSources.mean, 'count'],
        [scope, 'audio_live_sources_max', f.audioLiveSources.max, 'count'],
      );
    }
    rows.push(['audio', 'context_state', s.audio.current.contextState, 'enum'], ['audio', 'nodes_created_total', s.audio.current.nodesCreatedTotal, 'count'], ['audio', 'peak_live_sources', s.audio.peakLiveSourceNodesDuringRecording, 'count']);
    const esc = (v: number | string) => (typeof v === 'number' ? String(round3(v)) : /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    return ['scope,metric,value,unit', ...rows.map((r) => r.map(esc).join(','))].join('\n');
  }
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** 诊断构建里的单例；非诊断构建不会引用（打包时删除） */
export const perfDiag = /* @__PURE__ */ new PerfRecorder();
