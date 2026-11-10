import type { ReactNode } from 'react';
import { assembleBey, computeStats, type BeyStats } from '../game/beys/parts/assemble';
import { getPart, ROLE_INFO } from '../game/beys/parts/catalog';
import type { BeyLoadout, BeyRole, BladeStyle } from '../game/beys/parts/types';

/** 0xRRGGBB → #rrggbb */
export const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

export function statsOf(l: BeyLoadout): BeyStats {
  return computeStats(assembleBey(l));
}

/** 类型徽章：颜色 + 文字（不只用颜色传达信息，v2.0 §10.3） */
export function TypeBadge({ role, small }: { role: BeyRole; small?: boolean }) {
  const info = ROLE_INFO[role];
  return (
    <span className={`type-badge ${small ? 'small' : ''}`} style={{ borderColor: hex(info.color), color: hex(info.color) }}>
      <i style={{ background: hex(info.color) }}>{info.short}</i>
      {info.label}
    </span>
  );
}

const STAT_ROWS: [keyof BeyStats, string][] = [
  ['attack', '攻击'],
  ['defense', '防御'],
  ['stamina', '持久'],
  ['mobility', '机动'],
  ['burst', '抗爆'],
];

/** 四维 + 抗爆属性条（v2.0 §4.4 公式，只是展示）；compare 给出对照值时画出差值 */
export function StatBars({ stats, color, compare, rows = STAT_ROWS }: { stats: BeyStats; color: string; compare?: BeyStats; rows?: [keyof BeyStats, string][] }) {
  return (
    <div className="statbars">
      {rows.map(([k, label]) => {
        const v = stats[k];
        const d = compare ? v - compare[k] : 0;
        return (
          <div key={k} className="statbar">
            <span className="statbar-label">{label}</span>
            <div className="statbar-track">
              <div className="statbar-fill" style={{ width: `${Math.round(v * 100)}%`, background: color }} />
            </div>
            <span className={`statbar-val ${d > 0.02 ? 'up' : d < -0.02 ? 'down' : ''}`}>{Math.round(v * 100)}</span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Blade 俯视剪影（SVG）：与图纸生成器同一个参数化轮廓（瓣数 / 尖锐度 / 前掠 / 谷深比），
 * 外圈银色刃 + 类型色骨架 + 中心徽章。用于卡片，比实时渲染缩略图轻得多。
 */
const GLYPH: Record<BladeStyle, { lobes: number; sharp: number; skew: number; valley: number }> = {
  fang: { lobes: 3, sharp: 1.1, skew: 0.65, valley: 0.6 },
  bastion: { lobes: 6, sharp: 2.6, skew: 0, valley: 0.88 },
  gale: { lobes: 10, sharp: 3.0, skew: 0.15, valley: 0.85 },
  crescent: { lobes: 2, sharp: 1.2, skew: 0.3, valley: 0.7 },
  crown: { lobes: 4, sharp: 1.7, skew: 0.1, valley: 0.72 },
};

function outline(lobes: number, sharp: number, skew: number, valley: number, R: number): string {
  const n = lobes * 28;
  const pts: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const ang = t * Math.PI * 2;
    const ph = (t * lobes) % 1;
    const peak = 0.5 + skew * 0.22;
    const d = ((ph - peak + 0.5) % 1 + 1) % 1 - 0.5;
    const prof = Math.pow(Math.max(0, Math.cos(d * Math.PI)), sharp);
    const r = R * (valley + (1 - valley) * prof);
    pts.push(`${(50 + r * Math.cos(ang)).toFixed(2)},${(50 + r * Math.sin(ang)).toFixed(2)}`);
  }
  return `M${pts.join('L')}Z`;
}

export function BladeGlyph({ loadout, color, size = 72, spin }: { loadout: BeyLoadout; color: string; size?: number; spin?: boolean }) {
  const blade = getPart('blade', loadout.blade);
  const g = GLYPH[blade.visual.style];
  return (
    <svg className={`blade-glyph ${spin ? 'spin' : ''}`} width={size} height={size} viewBox="0 0 100 100" aria-hidden>
      <defs>
        <radialGradient id={`gl-${blade.id}`} cx="40%" cy="35%" r="75%">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="45%" stopColor="#c9d2de" />
          <stop offset="100%" stopColor="#5d6878" />
        </radialGradient>
      </defs>
      <path d={outline(g.lobes, g.sharp, g.skew, g.valley, 47)} fill={`url(#gl-${blade.id})`} stroke="#1a2130" strokeWidth={1.2} />
      <path d={outline(g.lobes, g.sharp, g.skew, Math.min(0.95, g.valley + 0.08), 35)} fill={color} opacity={0.92} />
      <circle cx="50" cy="50" r="17" fill="#0b0f19" stroke="#d6dde8" strokeWidth={2} />
      <circle cx="50" cy="50" r="9" fill={color} />
    </svg>
  );
}

/** 菜单页通用框架：左上返回 + 标题，内容区，底部操作条（拇指区） */
export function ScreenFrame({ title, sub, onBack, children, actions, testid }: { title: string; sub?: string; onBack?: () => void; children: ReactNode; actions?: ReactNode; testid?: string }) {
  return (
    <div className="screen" data-testid={testid}>
      <header className="screen-head">
        {onBack && (
          <button className="btn icon back" onClick={onBack} aria-label="返回" data-testid="back">
            ‹
          </button>
        )}
        <div>
          <div className="screen-title">{title}</div>
          {sub && <div className="screen-sub">{sub}</div>}
        </div>
      </header>
      <div className="screen-body">{children}</div>
      {actions && <footer className="screen-actions">{actions}</footer>}
    </div>
  );
}
