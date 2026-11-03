import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { FINISH_LABEL } from '../game/battle/BattleSystem';
import { GameEngine, type BeyHud, type GameSnapshot } from '../game/core/GameEngine';
import { GarageScreen } from './GarageScreen';
import { LauncherPad } from './LauncherPad';
import type { QualityLevel } from '../game/render/Quality';

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

  // 桌面调试快捷键：空格=标准力度发射，P=暂停，R=重新开始
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const phase = engine.store.get().phase;
      if (e.code === 'Space') {
        e.preventDefault();
        if (phase === 'title') engine.start();
        else if (phase === 'aim') engine.launch({ power: 0.85, aim: 0, tilt: 0 });
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

  return (
    <div className="overlay">
      {s.phase !== "garage" && <RotateHint />}
      {s.phase === 'loading' && <div className="center-card">正在加载物理引擎…</div>}
      {s.phase === 'error' && (
        <div className="center-card error">
          启动失败：{s.error}
          <br />
          请确认浏览器支持 WebGL 与 WebAssembly。
        </div>
      )}

      {s.phase === 'title' && (
        <div className="title-screen">
          <div className="logo">
            <span className="logo-a">BBX</span>
            <span className="logo-b">3D 陀螺竞技场</span>
          </div>
          <div className="matchup">
            <BeyCard hud={s.player} side="player" />
            <div className="vs">VS</div>
            <BeyCard hud={s.rival} side="rival" />
          </div>
          <div className="title-actions">
            <button className="btn big" onClick={() => engine.openGarage()} data-testid="open-garage">
              组装陀螺
            </button>
            <button className="btn primary big" onClick={() => engine.start()} data-testid="start">
              开始对战
            </button>
          </div>
          <div className="record">
            战绩 {s.save.wins} 胜 {s.save.losses} 负 · 累计 {s.save.points} 分
          </div>
        </div>
      )}

      {s.phase === 'garage' && <GarageScreen engine={engine} s={s} />}

      {s.slowmo && <div className="slowmo-vignette" />}

      {(s.phase === 'aim' || s.phase === 'battle' || s.phase === 'result') && (
        <>
          <div className="hud-top">
            <SpinBar hud={s.player} side="player" />
            <div className="hud-center">
              <div className="timer">{s.phase === 'aim' ? '准备' : s.time.toFixed(1)}</div>
              <div className="hits">撞击 {s.hits}</div>
            </div>
            <SpinBar hud={s.rival} side="rival" />
          </div>
          <button className="btn icon pause-btn" onClick={() => engine.pause()} aria-label="暂停" data-testid="pause">
            ❚❚
          </button>
        </>
      )}

      {s.phase === 'aim' && (
        <>
          <div className="aim-tip">拉绳越长、松手越快，转速越高；拉动时左右偏移可调整发射方向</div>
          <LauncherPad engine={engine} pull={s.pull} />
        </>
      )}

      {s.phase === 'paused' && (
        <div className="modal">
          <div className="modal-card">
            <h2>已暂停</h2>
            <button className="btn primary" onClick={() => engine.resume()} data-testid="resume">
              继续
            </button>
            <button className="btn" onClick={() => engine.restart()} data-testid="restart">
              重新开始
            </button>
            <button className="btn ghost" onClick={() => engine.toTitle()}>
              返回标题
            </button>
            <QualityPicker engine={engine} level={s.quality} />
          </div>
        </div>
      )}

      {s.phase === 'result' && s.result && (
        <div className="result-banner" data-testid="result">
          <div className={`result-title ${s.result.winner === 'player' ? 'win' : 'lose'}`}>
            {s.result.winner === 'player' ? '胜利！' : '败北'}
          </div>
          <div className="result-finish">
            {FINISH_LABEL[s.result.finish]} · {s.result.points} 分 · {s.result.duration.toFixed(1)} 秒
          </div>
          <div className="result-actions">
            <button className="btn primary" onClick={() => engine.restart()} data-testid="again">
              再来一局
            </button>
            <button className="btn" onClick={() => engine.openGarage()}>
              更换部件
            </button>
            <button className="btn ghost" onClick={() => engine.toTitle()}>
              返回标题
            </button>
          </div>
        </div>
      )}
      {s.fps > 0 && s.phase !== "garage" && <div className="fps">{s.fps} fps · {s.quality}</div>}
    </div>
  );
}

const QUALITY_LABEL: Record<QualityLevel, string> = { low: '流畅', medium: '均衡', high: '高清', ultra: '极致' };

function QualityPicker({ engine, level }: { engine: GameEngine; level: QualityLevel }) {
  return (
    <div className="quality">
      <div className="quality-label">画质（自动调整中：{QUALITY_LABEL[level]}）</div>
      <div className="quality-row">
        {(['low', 'medium', 'high', 'ultra'] as QualityLevel[]).map((q) => (
          <button key={q} className={`btn tiny ${q === level ? 'on' : ''}`} onClick={() => engine.setQuality(q)}>
            {QUALITY_LABEL[q]}
          </button>
        ))}
        <button className="btn tiny ghost" onClick={() => engine.setQuality('auto')}>
          自动
        </button>
      </div>
    </div>
  );
}

function BeyCard({ hud, side }: { hud: BeyHud; side: 'player' | 'rival' }) {
  return (
    <div className={`bey-card ${side}`}>
      <div className="bey-side">{side === 'player' ? '你' : '电脑'}</div>
      <div className="bey-name">{hud.name}</div>
      <div className="bey-code">{hud.code}</div>
    </div>
  );
}

function SpinBar({ hud, side }: { hud: BeyHud; side: 'player' | 'rival' }) {
  return (
    <div className={`spinbar ${side}`}>
      <div className="spinbar-label">
        <span>{hud.name}</span>
        {hud.dashing && <span className="dash">XTREME DASH</span>}
      </div>
      <div className="spinbar-track">
        <div className="spinbar-fill" style={{ width: `${Math.round(hud.spin * 100)}%` }} />
      </div>
      <div className="spinbar-rpm">{hud.rpm > 0 ? `${hud.rpm} rpm` : ''}</div>
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
