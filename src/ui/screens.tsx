import { useMemo, useState } from 'react';
import { AI_LEVELS, type AiLevel } from '../game/beys/motionIntent';
import { assembleBey, partMass } from '../game/beys/parts/assemble';
import { buildName, counterOf, ROLE_INFO, signatureOf, SIGNATURE_LIST, SIGNATURES, type SignatureKey } from '../game/beys/parts/catalog';
import type { BeyLoadout, BeyRole } from '../game/beys/parts/types';
import { FINISH_POINTS } from '../game/battle/match';
import type { ArenaId, GameEngine, GameSnapshot, ModeId } from '../game/core/GameEngine';
import { BladeGlyph, hex, ScreenFrame, StatBars, statsOf, TypeBadge } from './common';

/**
 * 菜单页（v2.0 §10.2 最小可玩闭环 6 屏）：主界面 / 陀螺库 / 模式与对手 / 竞技场选择 / 战斗准备，组装见 GarageScreen。
 * 导航（§10.1）：主界面是唯一枢纽；战斗流程单向线性：模式 → 竞技场 → 准备 → 战斗 → 结算。
 */

const colorOf = (l: BeyLoadout) => hex(signatureOf(l)?.color ?? ROLE_INFO[assembleBey(l).role].color);

// ───────────────────────── 主界面 ─────────────────────────

export function HomeScreen({ engine, s }: { engine: GameEngine; s: GameSnapshot }) {
  const me = s.loadout;
  const spec = useMemo(() => assembleBey(me), [me]);
  const color = colorOf(me);
  return (
    <div className="home" data-testid="home">
      <div className="home-left">
        <div className="logo">
          <span className="logo-a">BBX</span>
          <span className="logo-b">3D 陀螺竞技场</span>
        </div>
        <div className="home-menu">
          <button className="btn primary big" onClick={() => engine.navigate('mode')} data-testid="start">
            开始对战
          </button>
          <button className="btn wide" onClick={() => engine.navigate('library')} data-testid="open-library">
            陀螺库
          </button>
          <button className="btn wide" onClick={() => engine.openGarage()} data-testid="open-garage">
            组装陀螺
          </button>
        </div>
        <div className="record">
          战绩 {s.save.wins} 胜 {s.save.losses} 负 · 积分 {s.save.points} · 零件 12/12 · 竞技场 1/3
        </div>
      </div>
      <div className="home-right">
        <div className="build-card" style={{ borderColor: color }}>
          <div className="build-card-head">
            <BladeGlyph loadout={me} color={color} size={64} spin />
            <div>
              <div className="build-label">当前出战</div>
              <div className="build-name" style={{ color }}>
                {buildName(me)}
              </div>
              <TypeBadge role={spec.role} small />
            </div>
          </div>
          <div className="build-parts">
            {spec.blade.name} · {spec.ratchet.name} · {spec.bit.name} · {partMass(spec)}
          </div>
          <StatBars stats={statsOf(me)} color={color} />
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── 陀螺库 ─────────────────────────

const FILTERS: { key: BeyRole | 'all'; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'attack', label: '攻击' },
  { key: 'defense', label: '防守' },
  { key: 'balance', label: '平衡' },
  { key: 'stamina', label: '耐力' },
];

const ROLE_STYLE: Record<BeyRole, string> = {
  attack: '高压突击：主动切入、冲击、制造爆裂',
  defense: '稳固防御：守中承伤，对手失衡后反击',
  balance: '多面适应：按局势切换进攻与控位；唯一能轨道冲刺',
  stamina: '持久消耗：减少无效碰撞，拖垮对手自转',
};

const ROLE_WEAK: Record<BeyRole, string> = {
  attack: '自转掉得最快，自身锁扣弱',
  defense: '机动最弱，害怕被拖进耐力局',
  balance: '没有极端强项',
  stamina: '锁扣最低，最怕爆裂',
};

export function LibraryScreen({ engine, s }: { engine: GameEngine; s: GameSnapshot }) {
  const [filter, setFilter] = useState<BeyRole | 'all'>('all');
  const current = signatureOf(s.loadout)?.key;
  const list = SIGNATURE_LIST.filter((b) => filter === 'all' || b.role === filter);
  return (
    <ScreenFrame
      title="陀螺库"
      sub="四种战斗定位 · 零件 12/12 · 类型由 Bit 决定"
      onBack={() => engine.navigate('home')}
      testid="library"
      actions={
        <>
          <div className="filters">
            {FILTERS.map((f) => (
              <button key={f.key} className={`chip-btn ${filter === f.key ? 'on' : ''}`} onClick={() => setFilter(f.key)}>
                {f.label}
              </button>
            ))}
          </div>
          <button className="btn primary" onClick={() => engine.openGarage()} data-testid="library-garage">
            进入组装
          </button>
        </>
      }
    >
      <div className="sig-grid">
        {list.map((b) => {
          const color = hex(b.color);
          const spec = assembleBey(b.loadout);
          const on = current === b.key;
          return (
            <div key={b.key} className={`sig-card ${on ? 'on' : ''}`} style={{ borderColor: on ? color : undefined }} data-testid={`sig-${b.key}`}>
              <div className="sig-top" style={{ background: `linear-gradient(180deg, ${color}55, transparent)` }}>
                <BladeGlyph loadout={b.loadout} color={color} size={58} />
                <div>
                  <div className="sig-name" style={{ color }}>
                    {b.name}
                  </div>
                  <TypeBadge role={b.role} small />
                </div>
              </div>
              <div className="sig-parts">
                {spec.blade.name} · {spec.ratchet.name} · {spec.bit.name}
              </div>
              <StatBars stats={statsOf(b.loadout)} color={color} />
              <div className="sig-note">{ROLE_STYLE[b.role]}</div>
              <div className="sig-note weak">弱点：{ROLE_WEAK[b.role]}</div>
              <button className={`btn small ${on ? 'on' : ''}`} onClick={() => engine.equipSignature(b.key)} data-testid={`equip-${b.key}`}>
                {on ? '已装备' : '装备'}
              </button>
            </div>
          );
        })}
      </div>
    </ScreenFrame>
  );
}

// ───────────────────────── 模式与对手 ─────────────────────────

const MODES: { key: ModeId; name: string; desc: string; open: boolean }[] = [
  { key: 'free', name: '自由对战', desc: '自选构筑、对手与难度，先到 4 分', open: true },
  { key: 'challenge', name: '挑战模式', desc: '10 关阶梯，解锁零件与竞技场', open: false },
  { key: 'tournament', name: '锦标赛', desc: '8 人单败淘汰，3 轮晋级', open: false },
  { key: 'survival', name: '生存模式', desc: '连胜挑战，难度递增', open: false },
];

export function ModeScreen({ engine, s }: { engine: GameEngine; s: GameSnapshot }) {
  const setup = s.setup;
  const rival = setup.rival === 'random' ? null : SIGNATURES[setup.rival];
  return (
    <ScreenFrame
      title="模式与对手"
      sub="难度只改变电脑的决策，不改变任何物理参数"
      onBack={() => engine.navigate('home')}
      testid="mode"
      actions={
        <>
          <div className="pick-summary">
            对手：{rival ? `${rival.name}（${ROLE_INFO[rival.role].label}）` : '随机'} · {AI_LEVELS[setup.difficulty].label}
          </div>
          <button className="btn primary" onClick={() => engine.navigate('arena')} data-testid="mode-next">
            选择竞技场 ›
          </button>
        </>
      }
    >
      <div className="mode-row">
        {MODES.map((m) => (
          <button
            key={m.key}
            className={`mode-card ${setup.mode === m.key ? 'on' : ''} ${m.open ? '' : 'locked'}`}
            disabled={!m.open}
            onClick={() => m.open && engine.setSetup({ mode: m.key })}
            data-testid={`mode-${m.key}`}
          >
            <div className="mode-name">{m.name}</div>
            <div className="mode-desc">{m.desc}</div>
            <div className="mode-state">{m.open ? (setup.mode === m.key ? '✓ 已选择' : '可选') : '即将开放'}</div>
          </button>
        ))}
      </div>
      <div className="pick-label">对手</div>
      <div className="rival-row">
        {SIGNATURE_LIST.map((b) => {
          const color = hex(b.color);
          const on = setup.rival === b.key;
          return (
            <button key={b.key} className={`rival-chip ${on ? 'on' : ''}`} style={{ borderColor: on ? color : undefined }} onClick={() => engine.setSetup({ rival: b.key })} data-testid={`rival-${b.key}`}>
              <BladeGlyph loadout={b.loadout} color={color} size={34} />
              <span style={{ color }}>{b.name}</span>
              <small>{ROLE_INFO[b.role].label}</small>
            </button>
          );
        })}
        <button className={`rival-chip ${setup.rival === 'random' ? 'on' : ''}`} onClick={() => engine.setSetup({ rival: 'random' })} data-testid="rival-random">
          <span className="dice">?</span>
          <span>随机</span>
          <small>每场抽一位</small>
        </button>
      </div>
      <div className="pick-label">难度</div>
      <div className="seg">
        {(Object.keys(AI_LEVELS) as AiLevel[]).map((k) => (
          <button key={k} className={`seg-btn ${setup.difficulty === k ? 'on' : ''}`} onClick={() => engine.setSetup({ difficulty: k })} data-testid={`diff-${k}`}>
            {AI_LEVELS[k].label}
          </button>
        ))}
      </div>
    </ScreenFrame>
  );
}

// ───────────────────────── 竞技场选择 ─────────────────────────

const ARENAS: { key: ArenaId; name: string; theme: string; rules: string[]; fit: string; open: boolean }[] = [
  {
    key: 'standard',
    name: '标准竞技场',
    theme: '穹顶 · 工业科技风',
    rules: ['中央碗面 + 外圈轨道 + 3 个口袋', '平齿轴可在轨道上冲刺', '极限口袋 3 分 · 出界口袋 2 分'],
    fit: '平衡基准：四种类型都能打',
    open: true,
  },
  { key: 'velocity', name: '极限竞技场', theme: '疾驰环道', rules: ['轨道更宽，冲刺更强', '4 个口袋（2 个极限）'], fit: '偏向攻击 / 平衡', open: false },
  { key: 'sky', name: '天空竞技场', theme: '苍穹浮岛', rules: ['无轨道，外圈更陡', '口袋更宽，出界风险高'], fit: '偏向耐力 / 防守', open: false },
];

export function ArenaScreen({ engine, s }: { engine: GameEngine; s: GameSnapshot }) {
  return (
    <ScreenFrame
      title="竞技场"
      sub="地图只改变几何与规则，不加摩擦乘数或机关"
      onBack={() => engine.navigate('mode')}
      testid="arena"
      actions={
        <>
          <div className="pick-summary">终结分值：自转 1 · 出界 2 · 爆裂 2 · 极限 3</div>
          <button className="btn primary" onClick={() => engine.navigate('prep')} data-testid="arena-next">
            战斗准备 ›
          </button>
        </>
      }
    >
      <div className="arena-row">
        {ARENAS.map((a) => (
          <button
            key={a.key}
            className={`arena-card ${s.setup.arena === a.key ? 'on' : ''} ${a.open ? '' : 'locked'}`}
            disabled={!a.open}
            onClick={() => a.open && engine.setSetup({ arena: a.key })}
            data-testid={`arena-${a.key}`}
          >
            <ArenaGlyph id={a.key} />
            <div className="arena-name">{a.name}</div>
            <div className="arena-theme">{a.theme}</div>
            <ul>
              {a.rules.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
            <div className="arena-fit">{a.open ? a.fit : '即将开放'}</div>
          </button>
        ))}
      </div>
    </ScreenFrame>
  );
}

/** 竞技场俯视小图：碗面、轨道、口袋位置与宽度按 arenaSpec 的角度画（示意） */
function ArenaGlyph({ id }: { id: ArenaId }) {
  const pockets: [number, number, string][] =
    id === 'velocity'
      ? [
          [-90, 30, '#e8302a'],
          [90, 30, '#e8302a'],
          [30, 22, '#ffb323'],
          [150, 22, '#ffb323'],
        ]
      : [
          [-90, 28, '#e8302a'],
          [30, 20, '#ffb323'],
          [150, 20, '#ffb323'],
        ];
  const arc = (deg: number, w: number) => {
    const a0 = ((deg - w / 2) * Math.PI) / 180;
    const a1 = ((deg + w / 2) * Math.PI) / 180;
    const p = (r: number, a: number) => `${(50 + r * Math.cos(a)).toFixed(1)},${(50 + r * Math.sin(a)).toFixed(1)}`;
    return `M${p(40, a0)} A40,40 0 0 1 ${p(40, a1)} L${p(48, a1)} A48,48 0 0 0 ${p(48, a0)} Z`;
  };
  return (
    <svg className="arena-glyph" viewBox="0 0 100 100" width={86} height={86} aria-hidden>
      <circle cx="50" cy="50" r="40" fill="#1a2232" stroke="#6c7a92" strokeWidth={1.5} />
      {id !== 'sky' && <circle cx="50" cy="50" r={id === 'velocity' ? 31 : 35} fill="none" stroke="#39f0d8" strokeWidth={1.6} strokeDasharray="3 2" />}
      <circle cx="50" cy="50" r="24" fill="none" stroke="#3a4760" strokeWidth={1} />
      {pockets.map(([d, w, c]) => (
        <path key={d} d={arc(d, w)} fill={c} opacity={0.75} />
      ))}
      <circle cx="50" cy="50" r="3" fill="#8a96ad" />
    </svg>
  );
}

// ───────────────────────── 战斗准备 ─────────────────────────

function matchupHint(me: BeyRole, them: BeyRole): string {
  const c = counterOf(me, them);
  if (c > 0) return `相克：${ROLE_INFO[me].label} 克制 ${ROLE_INFO[them].label}（打法优势，不是必胜）`;
  if (c < 0) return `相克：${ROLE_INFO[them].label} 克制 ${ROLE_INFO[me].label}，注意避开对方的强项`;
  if (me === 'balance' || them === 'balance') return '平衡型在相克三角之外：没有硬克制';
  return '同类型对决：比拼构筑细节与发射';
}

export function PrepScreen({ engine, s }: { engine: GameEngine; s: GameSnapshot }) {
  const me = s.loadout;
  const them = s.rivalLoadout;
  const a = useMemo(() => assembleBey(me), [me]);
  const b = useMemo(() => assembleBey(them), [them]);
  const sa = statsOf(me);
  const sb = statsOf(them);
  const ca = colorOf(me);
  const cb = s.setup.rival === 'random' ? '#9aa6bb' : colorOf(them);
  const random = s.setup.rival === 'random';
  return (
    <ScreenFrame
      title="战斗准备"
      sub={`自由对战 · 标准竞技场 · ${AI_LEVELS[s.setup.difficulty].label} · 先到 4 分`}
      onBack={() => engine.navigate('arena')}
      testid="prep"
      actions={
        <>
          <button className="btn" onClick={() => engine.openGarage()} data-testid="prep-garage">
            换构筑
          </button>
          <button className="btn primary big" onClick={() => engine.startMatch()} data-testid="prep-start">
            开始比赛
          </button>
        </>
      }
    >
      <div className="versus">
        <div className="vs-card" style={{ borderColor: ca }}>
          <div className="vs-side">我方</div>
          <div className="vs-head">
            <BladeGlyph loadout={me} color={ca} size={56} spin />
            <div>
              <div className="vs-name" style={{ color: ca }}>
                {buildName(me)}
              </div>
              <TypeBadge role={a.role} small />
            </div>
          </div>
          <div className="vs-parts">
            {a.blade.name} · {a.ratchet.name} · {a.bit.name}
          </div>
          <StatBars stats={sa} color={ca} compare={random ? undefined : sb} />
        </div>
        <div className="vs-mid">
          <div className="vs">VS</div>
          <div className="vs-hint">{random ? '对手开赛时随机抽取' : matchupHint(a.role, b.role)}</div>
          <div className="vs-rules">
            自转 {FINISH_POINTS.spin} · 出界 {FINISH_POINTS.over} · 爆裂 {FINISH_POINTS.burst} · 极限 {FINISH_POINTS.xtreme}
            <br />
            每回合发射一次：拉绳力度分轻 / 中 / 重三档，左右偏移调整方向
          </div>
        </div>
        <div className="vs-card" style={{ borderColor: cb }}>
          <div className="vs-side">对手 · 电脑</div>
          {random ? (
            <div className="vs-head">
              <span className="dice big">?</span>
              <div>
                <div className="vs-name">随机对手</div>
              </div>
            </div>
          ) : (
            <>
              <div className="vs-head">
                <BladeGlyph loadout={them} color={cb} size={56} spin />
                <div>
                  <div className="vs-name" style={{ color: cb }}>
                    {buildName(them)}
                  </div>
                  <TypeBadge role={b.role} small />
                </div>
              </div>
              <div className="vs-parts">
                {b.blade.name} · {b.ratchet.name} · {b.bit.name}
              </div>
              <StatBars stats={sb} color={cb} compare={sa} />
            </>
          )}
        </div>
      </div>
    </ScreenFrame>
  );
}

/** 对手名（结算等处使用） */
export function rivalName(key: SignatureKey | 'random', loadout: BeyLoadout): string {
  return key === 'random' ? buildName(loadout) : SIGNATURES[key].name;
}
