import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { assembleBey, computeStats, partMass } from '../game/beys/parts/assemble';
import { listParts } from '../game/beys/parts/catalog';
import type { PartKind, PartSpec } from '../game/beys/parts/types';
import type { GameEngine, GameSnapshot } from '../game/core/GameEngine';

const TABS: { kind: PartKind; label: string; en: string }[] = [
  { kind: 'blade', label: '刀刃', en: 'BLADE' },
  { kind: 'ratchet', label: '棘轮', en: 'RATCHET' },
  { kind: 'bit', label: '轴尖', en: 'BIT' },
];

const ROLE_LABEL: Record<string, string> = { attack: '攻击型', defense: '防御型', stamina: '耐久型', balance: '平衡型' };

/** 每类部件在卡片上显示的 3 个关键属性（0..1） */
function partBars(p: PartSpec): [string, number][] {
  if (p.kind === 'blade') {
    return [
      ['攻击', p.attack],
      ['防御', p.defense],
      ['重量', (p.mass - 2.6) / 1.4],
    ];
  }
  if (p.kind === 'ratchet') {
    return [
      ['锁扣', p.lock],
      ['重量', (p.mass - 0.7) / 0.8],
      ['高度', (p.height - 0.09) / 0.08],
    ];
  }
  return [
    ['耐久', 1 - (p.spinDecay - 0.6) / 2.4],
    // P2.2.1：橡胶轴心摩擦系数调低后，机动性改按“漂移量”（轴心牵引跑动的强度）显示，更接近实战表现
    ['机动', p.drift / 0.2],
    ['牵引', p.gearGrip],
  ];
}

const clamp01 = (v: number) => Math.max(0.04, Math.min(1, v));

/**
 * 左右分栏的 3D 组装界面：
 *  左：部件分类 + 可滑动的部件卡片（缩略图由真实 3D 模型渲染）；
 *  右：引擎渲染的可交互 3D 陀螺（拖动旋转、双指缩放）+ 组合属性 + 操作按钮。
 */
export function GarageScreen({ engine, s }: { engine: GameEngine; s: GameSnapshot }) {
  const [tab, setTab] = useState<PartKind>('blade');
  const stageRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const draft = s.garage.draft;
  const spec = useMemo(() => assembleBey(draft), [draft]);
  const stats = useMemo(() => computeStats(spec), [spec]);
  const parts = useMemo(() => listParts(tab), [tab]);

  // 把右侧舞台区域告诉引擎，让 3D 模型居中显示在这里
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    // 3D 舞台铺满右栏，模型居中在“标题之下、属性面板之上”的空白区域
    const report = () => {
      const r = el.getBoundingClientRect();
      const top = headRef.current ? headRef.current.getBoundingClientRect().bottom : r.top;
      const bottom = panelRef.current ? panelRef.current.getBoundingClientRect().top : r.bottom;
      engine.setGarageFocus({ x: r.left, y: top, w: r.width, h: Math.max(60, bottom - top) });
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    window.addEventListener('resize', report);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', report);
      engine.setGarageFocus(null);
    };
  }, [engine]);

  // 手势：单指旋转，双指缩放，滚轮缩放
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const pts = new Map<number, { x: number; y: number }>();
    let pinch = 0;
    const down = (e: PointerEvent) => {
      el.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = Math.hypot(a.x - b.x, a.y - b.y);
      }
    };
    const move = (e: PointerEvent) => {
      const prev = pts.get(e.pointerId);
      if (!prev) return;
      e.preventDefault();
      const cur = { x: e.clientX, y: e.clientY };
      pts.set(e.pointerId, cur);
      if (pts.size === 1) {
        engine.garageRotate(cur.x - prev.x, cur.y - prev.y);
      } else if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch > 0) engine.garageZoom(d / pinch);
        pinch = d;
      }
    };
    const up = (e: PointerEvent) => {
      pts.delete(e.pointerId);
      pinch = 0;
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      engine.garageZoom(Math.exp(-e.deltaY * 0.0015));
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move, { passive: false });
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', wheel, { passive: false });
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('wheel', wheel);
    };
  }, [engine]);

  return (
    <div className="garage" data-testid="garage">
      <section className="garage-left">
        <header className="garage-head">
          <button className="btn icon back" onClick={() => engine.garageCancel()} aria-label="返回" data-testid="garage-back">
            ‹
          </button>
          <div>
            <div className="garage-title">组装陀螺</div>
            <div className="garage-sub">选择部件 · 实时组合</div>
          </div>
        </header>
        <nav className="garage-tabs">
          {TABS.map((t) => (
            <button
              key={t.kind}
              className={`tab ${tab === t.kind ? 'on' : ''}`}
              onClick={() => setTab(t.kind)}
              data-testid={`tab-${t.kind}`}
            >
              <span>{t.label}</span>
              <small>{t.en}</small>
            </button>
          ))}
        </nav>
        <div className="part-list" data-testid="part-list">
          {parts.map((p) => {
            const selected = draft[p.kind] === p.id;
            const thumb = s.garage.thumbs[`${p.kind}:${p.id}`];
            return (
              <button
                key={p.id}
                className={`part-card ${selected ? 'selected' : ''}`}
                onClick={() => engine.garageSelect(p.kind, p.id)}
                data-testid={`part-${p.id}`}
              >
                <div className="part-thumb">
                  {thumb ? <img src={thumb} alt={p.name} draggable={false} /> : <div className="thumb-loading" />}
                  {selected && <div className="part-check">✓</div>}
                </div>
                <div className="part-info">
                  <div className="part-name">{p.name}</div>
                  <div className="part-meta">
                    {p.code} · {(p.mass * 8.5).toFixed(1)} g
                    {p.kind === 'bit' ? ` · ${ROLE_LABEL[p.role]}` : ''}
                  </div>
                  <div className="mini-bars">
                    {partBars(p).map(([label, v]) => (
                      <div key={label} className="mini-bar">
                        <span>{label}</span>
                        <div className="mini-track">
                          <div className="mini-fill" style={{ width: `${clamp01(v) * 100}%` }} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
        <div className="part-desc">{parts.find((p) => p.id === draft[tab])?.desc}</div>
      </section>

      <section className="garage-right">
        <div className="stage" ref={stageRef} data-testid="garage-stage" />
        <div className="assembly-head" ref={headRef}>
          <div className="assembly-name">{spec.blade.name}</div>
          <div className="assembly-codes">
            <span className="chip red">{spec.blade.code}</span>
            <span className="chip">{spec.ratchet.code}</span>
            <span className="chip blue">{spec.bit.code}</span>
          </div>
          <div className="assembly-mass">总重 {partMass(spec)}</div>
        </div>
        <div className="assembly-panel" ref={panelRef}>
          <div className="stats">
            {(
              [
                ['攻击', stats.attack],
                ['防御', stats.defense],
                ['耐久', stats.stamina],
                ['机动', stats.mobility],
                ['重量', stats.weight],
                ['抗爆', stats.burst],
              ] as [string, number][]
            ).map(([k, v]) => (
              <div key={k} className="stat">
                <span>{k}</span>
                <div className="stat-track">
                  <div className="stat-fill" style={{ width: `${v * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
          <div className="assembly-actions">
            <button
              className={`btn small ${s.garage.exploded ? 'on' : ''}`}
              onClick={() => engine.garageToggleExplode()}
              data-testid="explode"
            >
              {s.garage.exploded ? '组合' : '分解'}
            </button>
            <button className="btn small ghost" onClick={() => engine.garageResetView()}>
              复位
            </button>
            <button className="btn small primary" onClick={() => engine.garageConfirm()} data-testid="garage-confirm">
              确认出战
            </button>
          </div>
        </div>
        <div className="stage-hint">拖动旋转 · 双指缩放</div>
      </section>
    </div>
  );
}
