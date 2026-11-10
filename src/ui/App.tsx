import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { GameEngine, type GameSnapshot } from '../game/core/GameEngine';
import type { QualityLevel } from '../game/render/Quality';
import { GarageScreen } from './GarageScreen';
import { BattleHud, MatchEndScreen, RoundBanner } from './hud';
import { LauncherPad } from './LauncherPad';
import { ArenaScreen, ChallengeScreen, HomeScreen, LibraryScreen, ModeScreen, PrepScreen } from './screens';

declare global {
  interface Window {
    /** 自动化测试和调试入口 */
    __game?: GameEngine;
  }
}

export function App() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [engine, setEngine] = useState<GameEngine | null>(null);

  useEffect(() => {
    const host = hostRef.current!;
    const e = new GameEngine(host);
    window.__game = e;
    setEngine(e);
    void e.init();
    return () => {
      e.dispose();
      if (window.__game === e) window.__game = undefined;
    };
  }, []);

  return (
    <div className="app">
      <div ref={hostRef} className="viewport" />
      {engine && <Overlay engine={engine} />}
    </div>
  );
}

function useSnapshot(engine: GameEngine): GameSnapshot {
  return useSyncExternalStore(engine.store.subscribe, engine.store.get);
}

function Overlay({ engine }: { engine: GameEngine }) {
  const s = useSnapshot(engine);
  const [settings, setSettings] = useState(false);

  // 桌面调试快捷键：空格 = 开赛 / 中档发射，回车 = 跳过回合休整，P = 暂停，R = 重赛
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const phase = engine.store.get().phase;
      if (e.code === 'Space') {
        e.preventDefault();
        if (phase === 'title') engine.start();
        else if (phase === 'aim') engine.launch({ power: 0.85, aim: 0, tilt: 0 });
      } else if (e.code === 'Enter') {
        engine.continueRound();
      } else if (e.code === 'KeyP') {
        if (phase === 'paused') engine.resume();
        else engine.pause();
      } else if (e.code === 'KeyR') {
        engine.restart();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [engine]);

  const inBattle = s.phase === 'aim' || s.phase === 'battle' || s.phase === 'roundEnd';

  return (
    <div className="overlay">
      {s.phase !== 'garage' && <RotateHint />}
      {s.phase === 'loading' && <div className="center-card">正在加载物理引擎…</div>}
      {s.phase === 'error' && (
        <div className="center-card error">
          启动失败：{s.error}
          <br />
          请确认浏览器支持 WebGL 与 WebAssembly。
        </div>
      )}

      {s.phase === 'title' && (
        <>
          {s.screen === 'home' && <HomeScreen engine={engine} s={s} />}
          {s.screen === 'library' && <LibraryScreen engine={engine} s={s} />}
          {s.screen === 'mode' && <ModeScreen engine={engine} s={s} />}
          {s.screen === 'arena' && <ArenaScreen engine={engine} s={s} />}
          {s.screen === 'prep' && <PrepScreen engine={engine} s={s} />}
          {s.screen === 'challenge' && <ChallengeScreen engine={engine} s={s} />}
          {s.screen === 'home' && (
            <button className="btn icon settings-btn" onClick={() => setSettings(true)} aria-label="设置" data-testid="open-settings">
              设置
            </button>
          )}
        </>
      )}

      {s.phase === 'garage' && <GarageScreen engine={engine} s={s} />}

      {inBattle && <BattleHud engine={engine} s={s} />}
      {s.phase === 'aim' && (
        <>
          <div className="aim-tip">按住右侧拉绳向下拉：越长、松手越快越有力（轻 / 中 / 重三档）；拉动时左右偏移调整方向</div>
          <LauncherPad engine={engine} pull={s.pull} />
        </>
      )}
      {s.phase === 'roundEnd' && <RoundBanner engine={engine} s={s} />}
      {s.phase === 'matchEnd' && <MatchEndScreen engine={engine} s={s} />}

      {s.phase === 'paused' && (
        <div className="modal">
          <div className="modal-card">
            <h2>已暂停</h2>
            <button className="btn primary" onClick={() => engine.resume()} data-testid="resume">
              继续
            </button>
            <button className="btn" onClick={() => engine.restart()} data-testid="restart">
              重赛
            </button>
            <button className="btn ghost" onClick={() => engine.toTitle()} data-testid="quit">
              返回主界面
            </button>
            <SettingsBody engine={engine} s={s} />
          </div>
        </div>
      )}

      {settings && s.phase === 'title' && (
        <div className="modal" onClick={() => setSettings(false)}>
          <div className="modal-card" onClick={(e: React.MouseEvent) => e.stopPropagation()} data-testid="settings">
            <h2>设置</h2>
            <SettingsBody engine={engine} s={s} />
            <button className="btn primary" onClick={() => setSettings(false)} data-testid="settings-done">
              完成
            </button>
          </div>
        </div>
      )}
      {s.fps > 0 && s.phase !== 'garage' && s.settings.showFps && <PerfBadge engine={engine} fps={s.fps} quality={s.quality} />}
    </div>
  );
}

/**
 * 帧率角标：点一下展开性能面板（真机实测用）。
 * 面板每秒刷新：帧间隔中位数 / P95 / 最长帧、主循环各段 CPU 耗时、绘制调用。
 * GPU 耗时浏览器拿不到，只能看“帧间隔明显大于 CPU 合计”来判断瓶颈在 GPU。
 */
function PerfBadge({ engine, fps, quality }: { engine: GameEngine; fps: number; quality: string }) {
  const [open, setOpen] = useState(false);
  const [p, setP] = useState<ReturnType<GameEngine['debugPerf']> | null>(null);
  useEffect(() => {
    if (!open) return;
    engine.debugPerf(true);
    const id = setInterval(() => setP(engine.debugPerf(true)), 1000);
    return () => clearInterval(id);
  }, [open, engine]);
  const f = (v: number) => v.toFixed(2);
  return (
    <div className={`fps ${open ? 'open' : ''}`} data-testid="perf-badge" onClick={() => setOpen(!open)}>
      {fps} fps · {quality}
      {open && p && (
        <div className="perf-panel">
          <div>帧间隔 中位 {f(p.intervalP50)} · P95 {f(p.intervalP95)} · P99 {f(p.intervalP99)} · 最长逻辑+提交 {f(p.maxFrameMs)} ms</div>
          <div>
            刷新基准 {p.cadenceHz.toFixed(1)} Hz{p.cadenceMeasured ? '' : '（默认）'} · 漏帧率 {(p.missRatio * 100).toFixed(1)}%
          </div>
          <div>
            CPU/帧：物理 {f(p.physicsMs)}（{f(p.physStepsPerFrame)} 步）· 同步 {f(p.syncMs)} · 特效 {f(p.fxMs)} · 镜头 {f(p.camMs)} · UI {f(p.uiMs)} · 渲染提交 {f(p.renderSubmitMs)} ms
          </div>
          <div>
            绘制调用 {p.calls} · 三角形 {(p.triangles / 1000).toFixed(0)}k{p.heapMB > 0 ? ` · JS 堆 ${p.heapMB.toFixed(1)} MB` : ''}
          </div>
        </div>
      )}
    </div>
  );
}

const QUALITY_LABEL: Record<QualityLevel, string> = { low: '流畅', medium: '均衡', high: '高清', ultra: '极致' };

/**
 * 设置（v2.0 §10.2 设置面板，S6 完整版）：画质（自动 / 四档）+ 帧率显示、音效、战斗镜头（跟随 / 全场）、语言、辅助（减特效）。
 * 全部随存档保存。没有的内容不做假选项：游戏目前没有背景音乐，界面只有简体中文。
 */
function SettingsBody({ engine, s }: { engine: GameEngine; s: GameSnapshot }) {
  const st = s.settings;
  return (
    <div className="settings-body" data-testid="settings-body">
      <div className="set-row">
        <span className="set-label">画质</span>
        <div className="quality-row">
          {(['auto', 'low', 'medium', 'high', 'ultra'] as const).map((q) => (
            <button key={q} className={`btn tiny ${st.quality === q ? 'on' : ''}`} onClick={() => engine.setQuality(q)} data-testid={`quality-${q}`}>
              {q === 'auto' ? `自动（当前 ${QUALITY_LABEL[s.quality]}）` : QUALITY_LABEL[q]}
            </button>
          ))}
        </div>
      </div>
      <div className="set-row">
        <span className="set-label">帧率显示</span>
        <button className={`btn tiny ${st.showFps ? 'on' : ''}`} onClick={() => engine.setSettings({ showFps: !st.showFps })} data-testid="toggle-fps">
          {st.showFps ? '显示' : '隐藏'}
        </button>
      </div>
      <div className="set-row">
        <span className="set-label">音效</span>
        <button className={`btn tiny ${st.sound ? 'on' : ''}`} onClick={() => engine.setSettings({ sound: !st.sound })} data-testid="toggle-sound">
          音效：{st.sound ? '开' : '关'}
        </button>
      </div>
      <div className="set-row">
        <span className="set-label">战斗镜头</span>
        <button className={`btn tiny ${st.camera === 'follow' ? 'on' : ''}`} onClick={() => engine.setSettings({ camera: 'follow' })} data-testid="camera-follow">
          跟随
        </button>
        <button className={`btn tiny ${st.camera === 'overview' ? 'on' : ''}`} onClick={() => engine.setSettings({ camera: 'overview' })} data-testid="camera-overview">
          全场
        </button>
        <small>战斗中仍可随时切换</small>
      </div>
      <div className="set-row">
        <span className="set-label">语言</span>
        <span className="set-value">简体中文</span>
        <small>其他语言暂未提供</small>
      </div>
      <div className="set-row">
        <span className="set-label">辅助</span>
        <button className={`btn tiny ${st.reduceEffects ? 'on' : ''}`} onClick={() => engine.setSettings({ reduceEffects: !st.reduceEffects })} data-testid="toggle-fx">
          减特效：{st.reduceEffects ? '开' : '关'}
        </button>
        <small>关闭爆裂慢动作与镜头震动</small>
      </div>
    </div>
  );
}

function RotateHint() {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return (
    <div className="rotate-hint" onClick={() => setDismissed(true)}>
      <div className="rotate-icon">⟳</div>
      <div>请将手机横过来，横屏战斗体验更好</div>
      <div className="rotate-sub">点击继续竖屏游玩</div>
    </div>
  );
}
