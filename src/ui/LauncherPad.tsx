import { useEffect, useRef, useState } from 'react';
import type { GameEngine } from '../game/core/GameEngine';
import type { PullState } from '../game/launcher/PullStringGesture';
import { powerTier } from '../game/launcher/launch';
import { PowerTiers } from './hud';

/**
 * 拉绳发射操作区（触摸 / 鼠标通用）：
 * 按住右侧拉绳把手 → 向下拉 → 左右偏移瞄准 → 松手发射。
 * 绳子、力度条都根据引擎返回的 PullState 实时绘制。
 */
export function LauncherPad({ engine, pull }: { engine: GameEngine; pull: PullState }) {
  const padRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const pointerId = useRef<number | null>(null);

  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointerId.current) return;
      e.preventDefault();
      engine.pullMove(e.clientX, e.clientY);
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== pointerId.current) return;
      pointerId.current = null;
      setAnchor(null);
      if (e.type === 'pointercancel') engine.pullCancel();
      else engine.pullEnd();
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [engine]);

  const onDown = (e: React.PointerEvent) => {
    if (pointerId.current !== null) return;
    e.preventDefault();
    pointerId.current = e.pointerId;
    const maxPull = Math.min(260, Math.max(120, window.innerHeight * 0.42));
    setAnchor({ x: e.clientX, y: e.clientY });
    engine.pullStart(e.clientX, e.clientY, maxPull);
  };

  const power = Math.round(pull.power * 100);
  const hue = 170 - pull.power * 170;

  return (
    <>
      <div ref={padRef} className="launcher-pad" onPointerDown={onDown} data-testid="launcher-pad">
        {!pull.active && (
          <div className="ripcord-idle">
            <div className="ripcord-handle" />
            <div className="ripcord-hint">按住拉绳向下拉<br />松手发射</div>
          </div>
        )}
      </div>
      {pull.active && anchor && (
        <svg className="cord-layer" width="100%" height="100%">
          <line
            x1={anchor.x}
            y1={anchor.y - 40}
            x2={anchor.x + pull.dx}
            y2={anchor.y + pull.dy}
            stroke="#fff"
            strokeWidth={4}
            strokeLinecap="round"
          />
          <circle cx={anchor.x} cy={anchor.y - 40} r={10} fill="#1b1f28" stroke="#e8302a" strokeWidth={4} />
          <circle
            cx={anchor.x + pull.dx}
            cy={anchor.y + pull.dy}
            r={22}
            fill="none"
            stroke={`hsl(${hue},90%,55%)`}
            strokeWidth={6}
          />
        </svg>
      )}
      <PowerTiers power={pull.power} active={pull.active} />
      {pull.active && (
        <div className="aim-readout">
          方向 {pull.aim > 0.15 ? '右' : pull.aim < -0.15 ? '左' : '中'} · 力度 {powerTier(pull.power).label}（{power}）
        </div>
      )}
    </>
  );
}
