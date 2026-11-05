/**
 * Stage 0 性能诊断面板（仅诊断构建渲染；非诊断构建打包时删除）。
 *
 * 左下角 fps 角标右侧有一个小“DIAG”按钮，点开后：
 *  - 开始记录 / 记录 60 秒（自动停止）/ 自动对战 60 秒（用标准力度自动发射、结束后自动再来一局）；
 *  - 停止后显示摘要，可复制 / 分享摘要 JSON、完整 JSON（含逐帧数据）、逐帧 CSV、摘要 CSV。
 * 记录期间面板收起，只留一个每秒刷新一次的计时角标，尽量不增加渲染负担。
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { GameEngine } from '../game/core/GameEngine';
import { BUILD_INFO } from '../game/diag/flag';
import { perfDiag } from '../game/diag/PerfRecorder';

type Summary = ReturnType<typeof perfDiag.summary>;

const AUTO_LAUNCH = { power: 0.85, aim: 0, tilt: 0 };

export function DiagPanel({ engine }: { engine: GameEngine }) {
  const [open, setOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [msg, setMsg] = useState('');
  const [fallback, setFallback] = useState<{ name: string; text: string } | null>(null);
  const auto = useRef<number | null>(null);
  const resultSince = useRef(0);

  const stopAuto = () => {
    if (auto.current !== null) clearInterval(auto.current);
    auto.current = null;
  };

  const finish = () => {
    perfDiag.stop();
    stopAuto();
    setRecording(false);
    setSummary(perfDiag.summary());
    setOpen(true);
  };

  useEffect(() => {
    perfDiag.onAutoStop = () => {
      stopAuto();
      setRecording(false);
      setSummary(perfDiag.summary());
      setOpen(true);
    };
    return () => {
      perfDiag.onAutoStop = null;
      stopAuto();
    };
  }, []);

  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => setElapsed(Math.floor(perfDiag.elapsedMs / 1000)), 1000);
    return () => clearInterval(id);
  }, [recording]);

  const start = (seconds: number, autoBattle: boolean) => {
    setSummary(null);
    setMsg('');
    setFallback(null);
    setElapsed(0);
    if (autoBattle) {
      // 只调用游戏已有的公开指令（与桌面空格键 / 自动化测试相同），不改游戏逻辑
      const step = () => {
        const ph = engine.store.get().phase;
        if (ph === 'title') engine.start();
        else if (ph === 'paused') engine.resume();
        else if (ph === 'aim') engine.launch(AUTO_LAUNCH);
        else if (ph === 'result') {
          if (!resultSince.current) resultSince.current = performance.now();
          else if (performance.now() - resultSince.current > 2500) {
            resultSince.current = 0;
            engine.restart();
          }
        }
        if (ph !== 'result') resultSince.current = 0;
      };
      step();
      auto.current = window.setInterval(step, 300);
    }
    perfDiag.start(seconds);
    setRecording(true);
    setOpen(false);
  };

  const deliver = async (name: string, text: string, mime: string, mode: 'copy' | 'share') => {
    setFallback(null);
    try {
      if (mode === 'share') {
        const file = new File([text], name, { type: mime });
        const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
        if (nav.share && nav.canShare?.({ files: [file] })) {
          await nav.share({ files: [file], title: name });
          setMsg(`已打开分享：${name}`);
          return;
        }
        // 不支持文件分享：退回下载链接
        const url = URL.createObjectURL(file);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        setMsg(`当前环境不支持文件分享，已尝试下载 ${name}；如无反应请用“复制”`);
        return;
      }
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        setMsg(`已复制 ${name}（${(text.length / 1024).toFixed(1)} KB）`);
        return;
      }
      throw new Error('clipboard unavailable');
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
      // 最后手段：显示可全选的文本框
      setFallback({ name, text });
      setMsg(`自动${mode === 'copy' ? '复制' : '分享'}失败，请在下方文本框里全选复制`);
    }
  };

  const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const base = () => `bbx-perf-${BUILD_INFO.sha.slice(0, 7)}-${stamp()}`;

  if (recording && !open) {
    return (
      <button style={chip(true)} onClick={() => setOpen(true)} data-testid="diag-rec">
        ● REC {elapsed}s
      </button>
    );
  }

  return (
    <>
      {!open && (
        <button style={chip(false)} onClick={() => setOpen(true)} data-testid="diag-open">
          DIAG {BUILD_INFO.sha.slice(0, 7)}
        </button>
      )}
      {open && (
        <div style={panel} data-testid="diag-panel" onPointerDown={(e) => e.stopPropagation()}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <b>Stage 0 性能诊断</b>
            <button style={btn} onClick={() => setOpen(false)}>
              收起
            </button>
          </div>
          <div style={small}>
            构建 {BUILD_INFO.sha} · {BUILD_INFO.label} · 打包时间 {BUILD_INFO.time}
          </div>
          {recording ? (
            <div style={row}>
              <span>记录中 {Math.floor(perfDiag.elapsedMs / 1000)} s · {perfDiag.frames} 帧</span>
              <button style={{ ...btn, background: '#c0392b' }} onClick={finish} data-testid="diag-stop">
                停止
              </button>
            </div>
          ) : (
            <div style={row}>
              <button style={btn} onClick={() => start(0, false)} data-testid="diag-start">
                开始记录（手动停止）
              </button>
              <button style={btn} onClick={() => start(60, false)} data-testid="diag-start60">
                记录 60 秒
              </button>
              <button style={btn} onClick={() => start(60, true)} data-testid="diag-auto60">
                自动对战 60 秒
              </button>
            </div>
          )}
          {summary && <SummaryView s={summary} />}
          {summary && (
            <div style={row}>
              <button style={btn} onClick={() => deliver(`${base()}-summary.json`, JSON.stringify(summary, null, 1), 'application/json', 'copy')} data-testid="diag-copy-summary">
                复制摘要 JSON
              </button>
              <button style={btn} onClick={() => deliver(`${base()}.json`, perfDiag.toJSON(true), 'application/json', 'copy')} data-testid="diag-copy-json">
                复制完整 JSON
              </button>
              <button style={btn} onClick={() => deliver(`${base()}-frames.csv`, perfDiag.toCSV(), 'text/csv', 'copy')} data-testid="diag-copy-csv">
                复制逐帧 CSV
              </button>
              <button style={btn} onClick={() => deliver(`${base()}-summary.csv`, perfDiag.summaryCSV(), 'text/csv', 'copy')}>
                复制摘要 CSV
              </button>
              <button style={btn} onClick={() => deliver(`${base()}.json`, perfDiag.toJSON(true), 'application/json', 'share')}>
                分享 JSON 文件
              </button>
              <button style={btn} onClick={() => deliver(`${base()}-frames.csv`, perfDiag.toCSV(), 'text/csv', 'share')}>
                分享 CSV 文件
              </button>
            </div>
          )}
          {msg && <div style={{ ...small, color: '#ffd76a' }}>{msg}</div>}
          {fallback && (
            <textarea
              readOnly
              value={fallback.text}
              style={{ width: '100%', height: 120, fontSize: 10, fontFamily: 'monospace' }}
              onFocus={(e) => e.currentTarget.select()}
            />
          )}
        </div>
      )}
    </>
  );
}

function SummaryView({ s }: { s: Summary }) {
  const a = s.all;
  const b = s.battleOnly;
  const f = (v: number | null | undefined, d = 2) => (v == null ? '—' : v.toFixed(d));
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const line = (label: string, x: typeof a) => (
    <div>
      <b>{label}</b> {x.frames} 帧 / {f(x.durationS, 1)} s · 平均 {f(x.avgFps, 1)} fps · 间隔 P50 {f(x.intervalP50)} / P95 {f(x.intervalP95)} / P99 {f(x.intervalP99)} / 最长 {f(x.maxFrameMs)} ms · ≤16.7 ms {pct(x.ratioAtMost16_7ms)}（≤18 ms {pct(x.ratioAtMost18ms)}）· &gt;33.4 ms 长帧 {x.longFrames.total} 帧（每 60 s {f(x.longFrames.per60s, 1)}，前 60 s {x.longFrames.first60s ?? '不足 60 s'}）
    </div>
  );
  const c = b.frames ? b.cpu : a.cpu;
  return (
    <div style={{ ...small, lineHeight: 1.45 }} data-testid="diag-summary">
      <div>
        时长 {f(s.recording.durationS, 1)} s · 样本 {s.recording.samples} 帧 · rAF {f(s.recording.rafRateHz, 1)} Hz · 计时精度 {f(s.recording.timerResolutionMs, 3)} ms · 诊断自耗 {f(s.recording.diagOverheadPerFrameMs, 3)} ms/帧
      </div>
      {line('全部', a)}
      {line('对战中', b)}
      <div>
        CPU（{b.frames ? '对战中' : '全部'}，均值 ms/帧）：合计 {f(c.frameCpu.mean)}（P95 {f(c.frameCpu.p95)}，最长 {f(c.frameCpu.max)}）= 游戏更新 {f(c.tick.mean)} [物理 {f(c.physics.mean)}（{f(c.physStepsPerFrame.mean)} 步）· 同步 {f(c.sync.mean)} · 特效 {f(c.fx.mean)} · 镜头 {f(c.cam.mean)} · UI {f(c.ui.mean)} · 其他 {f(c.tickOther.mean)}] + 渲染提交 {f(c.renderSubmit.mean)} + 其他 {f(c.frameOther.mean)}；unattributed render/composition/system scheduling {f(c.unattributed.mean)}
      </div>
      <div>
        渲染：draw calls 均值 {f(a.render.drawCalls.mean, 0)} / 最大 {f(a.render.drawCalls.max, 0)} · 三角形 均值 {f(a.render.triangles.mean / 1000, 1)}k / 最大 {f(a.render.triangles.max / 1000, 1)}k · 像素比 {s.renderState?.pixelRatio}（期间 {a.render.pixelRatios.join(', ')}）· 阴影 {s.renderState?.shadowsEnabled ? `开 ${s.renderState?.shadowMapSizePx}px` : '关'} · 画质 {s.renderState?.quality}（{s.renderState?.qualityMode}；期间 {a.render.qualities.join(', ')}）
      </div>
      <div>
        音频：上下文 {s.audio.current.contextState} · 累计节点 {s.audio.current.nodesCreatedTotal} · 正在播放源节点 {s.audio.current.liveSourceNodes}（期间峰值 {s.audio.peakLiveSourceNodesDuringRecording}）· 状态变化 {s.audio.stateEvents.length} 次
      </div>
      <div>事件 {s.events.length} 条（阶段 / 画质 / 前后台 / 音频状态，见 JSON events）</div>
    </div>
  );
}

const chip = (rec: boolean): CSSProperties => ({
  position: 'absolute',
  left: 'calc(env(safe-area-inset-left, 0px) + 8px)',
  bottom: 'calc(env(safe-area-inset-bottom, 0px) + 34px)',
  zIndex: 60,
  pointerEvents: 'auto',
  font: '600 10px/1 ui-monospace, Menlo, monospace',
  padding: '5px 7px',
  borderRadius: 6,
  border: '1px solid rgba(255,255,255,0.35)',
  color: '#fff',
  background: rec ? 'rgba(192,57,43,0.85)' : 'rgba(20,24,40,0.7)',
});

const panel: CSSProperties = {
  position: 'absolute',
  left: 'calc(env(safe-area-inset-left, 0px) + 8px)',
  right: 'calc(env(safe-area-inset-right, 0px) + 8px)',
  bottom: 'calc(env(safe-area-inset-bottom, 0px) + 8px)',
  maxHeight: '86%',
  overflowY: 'auto',
  zIndex: 61,
  pointerEvents: 'auto',
  padding: 10,
  borderRadius: 10,
  background: 'rgba(12,14,24,0.94)',
  color: '#e8ecf5',
  font: '12px/1.35 -apple-system, system-ui, sans-serif',
  border: '1px solid rgba(255,255,255,0.18)',
  userSelect: 'text',
  WebkitUserSelect: 'text',
};

const row: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 6, margin: '8px 0', alignItems: 'center' };
const small: CSSProperties = { fontSize: 11, opacity: 0.9, marginTop: 4 };
const btn: CSSProperties = {
  font: '600 12px/1 -apple-system, system-ui, sans-serif',
  padding: '8px 10px',
  borderRadius: 7,
  border: '1px solid rgba(255,255,255,0.25)',
  background: '#2a3350',
  color: '#fff',
};
