import { FINISH_LABEL, FINISH_POINTS, type FinishType } from '../game/battle/match';
import type { BeyHud, GameEngine, GameSnapshot, RoundView } from '../game/core/GameEngine';
import { POWER_TIERS, powerTier } from '../game/launcher/launch';
import { hex, TypeBadge } from './common';

/**
 * 战斗 HUD（v2.0 §10.2 图 7）：顶部状态条 ≤ 44pt，不遮挡场地中央；
 * 双方自转条（= 血条）+ 爆裂应力条、比分（先到 4 分）、回合与计时；左下角镜头 / 暂停。
 * 发射后没有赛中操作（R5）。
 */

function SidePanel({ hud, side }: { hud: BeyHud; side: 'player' | 'rival' }) {
  const color = hex(hud.color);
  const hot = hud.stress >= 0.7;
  return (
    <div className={`hud-side ${side}`}>
      <div className="hud-name">
        <span style={{ color }}>{side === 'player' ? '我方 · ' : '对手 · '}{hud.name}</span>
        {hud.dashing && <span className="dash">轨道冲刺</span>}
        {hud.burst && <span className="burst-tag">爆裂</span>}
      </div>
      <div className="hud-bar spin" aria-label="自转">
        <div className="hud-fill" style={{ width: `${Math.round(hud.spin * 100)}%`, background: color }} />
      </div>
      <div className={`hud-bar stress ${hot ? 'hot' : ''}`} aria-label="爆裂应力">
        <div className="hud-fill" style={{ width: `${Math.round(hud.stress * 100)}%` }} />
      </div>
      <div className="hud-meta">
        自转 {Math.round(hud.spin * 100)} · 爆裂 {hud.stress.toFixed(2)}
      </div>
    </div>
  );
}

const fmt = (t: number) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

export function BattleHud({ engine, s }: { engine: GameEngine; s: GameSnapshot }) {
  const m = s.match;
  // 回合结束横幅期间显示刚结束的那一回合（比分已更新，回合序号还没进入下一回合）
  const shown = s.phase === 'roundEnd' && s.lastRound ? s.lastRound.number : m?.round;
  const roundLabel = m ? (m.decider && s.phase !== 'roundEnd' ? '决胜轮' : `第 ${shown} 回合`) : '';
  return (
    <>
      <div className="hud-top" data-testid="hud">
        <SidePanel hud={s.player} side="player" />
        <div className="hud-center">
          <div className="score" data-testid="score">
            <span>{m?.score.player ?? 0}</span>
            <i>:</i>
            <span>{m?.score.rival ?? 0}</span>
          </div>
          <div className="hud-round">
            {roundLabel} · {s.phase === 'aim' ? '准备发射' : fmt(s.time)}
          </div>
        </div>
        <SidePanel hud={s.rival} side="rival" />
      </div>
      {m?.decider && s.phase === 'aim' && <div className="decider-banner">决胜轮 · 先拿到第 4 分者获胜</div>}
      <div className="hud-left">
        {(s.phase === 'battle' || s.phase === 'roundEnd') && (
          <button className="btn icon" onClick={() => engine.toggleCamera()} data-testid="camera">
            镜头
          </button>
        )}
        <button className="btn icon" onClick={() => engine.pause()} aria-label="暂停" data-testid="pause">
          ❚❚
        </button>
      </div>
      {s.phase === 'battle' && s.time < 3 && <div className="watch-tip">发射后无赛中操作 · 观看战斗</div>}
    </>
  );
}

/** 发射准备时的力度档位条：连续拉绳力度 + 三档刻度，松手归到所在档 */
export function PowerTiers({ power, active }: { power: number; active: boolean }) {
  const tier = active ? powerTier(power) : null;
  return (
    <div className="tier-meter" data-testid="tier-meter">
      <div className="tier-track">
        <div className="tier-fill" style={{ height: `${Math.round(power * 100)}%` }} />
        <div className="tier-mark" style={{ bottom: '55%' }} />
        <div className="tier-mark" style={{ bottom: '80%' }} />
      </div>
      <div className="tier-labels">
        {[...POWER_TIERS].reverse().map((t) => (
          <span key={t.key} className={tier?.key === t.key ? 'on' : ''}>
            {t.label}
          </span>
        ))}
      </div>
    </div>
  );
}

const FINISH_ICON: Record<FinishType, string> = { spin: '◎', over: '⇲', burst: '✸', xtreme: '★' };

/** 回合结束横幅（顶部，不用中央弹窗；v2.0 §10.3） */
export function RoundBanner({ engine, s }: { engine: GameEngine; s: GameSnapshot }) {
  const r = s.lastRound;
  if (!r) return null;
  const o = r.outcome;
  const win = o.kind === 'win' && o.winner === 'player';
  const cls = o.kind === 'draw' ? 'draw' : win ? 'win' : 'lose';
  return (
    <button className={`round-banner ${cls}`} onClick={() => engine.continueRound()} data-testid="round-banner">
      <div className="rb-title">
        {o.kind === 'draw' ? (
          <>平局 · 本回合重赛</>
        ) : (
          <>
            <b>{FINISH_ICON[o.finish!]}</b> {FINISH_LABEL[o.finish!]}
            {o.own ? '（自灭）' : ''} · {win ? '我方' : '对手'} +{o.points}
          </>
        )}
      </div>
      <div className="rb-text">{r.text}</div>
      <div className="rb-sub">
        第 {r.number} 回合 · {r.stats.duration.toFixed(1)} 秒 · 接触 {r.stats.contacts} 次 · 点击继续
      </div>
    </button>
  );
}

function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat-cell">
      <div className="stat-v">{value}</div>
      <div className="stat-k">{label}</div>
    </div>
  );
}

/** 比赛结算（v2.0 §10.2 图 8 / §6.6）：胜负横幅、比分、每回合终结、四项关键数据、重赛 / 换构筑 / 返回 */
export function MatchEndScreen({ engine, s }: { engine: GameEngine; s: GameSnapshot }) {
  const m = s.match;
  if (!m) return null;
  const won = m.winner === 'player';
  const rounds = m.rounds;
  const sum = (f: (r: RoundView) => number) => rounds.reduce((a, r) => a + f(r), 0);
  const maxImp = Math.max(0, ...rounds.map((r) => r.stats.maxImpulse));
  const peak = Math.max(0, ...rounds.map((r) => Math.max(r.stats.peakStress.player, r.stats.peakStress.rival)));
  const decisive = [...rounds].reverse().find((r) => r.outcome.kind === 'win');
  const cr = s.challengeResult;
  return (
    <div className="match-end" data-testid="result">
      <div className={`me-title ${won ? 'win' : 'lose'}`}>{won ? '胜 利！' : '败 北'}</div>
      <div className="me-score">
        <span style={{ color: hex(s.player.color) }}>{s.player.name}</span>
        <b>
          {m.score.player} : {m.score.rival}
        </b>
        <span style={{ color: hex(s.rival.color) }}>{s.rival.name}</span>
      </div>
      {decisive && <div className="me-reason">{decisive.text}</div>}
      {cr && (
        <div className={`me-challenge ${cr.cleared ? 'ok' : 'fail'}`} data-testid="challenge-result">
          <div>
            挑战第 {cr.level} 关 · {cr.condition} · {cr.detail}
          </div>
          <div>
            {cr.cleared
              ? cr.firstClear
                ? `通关！解锁 ${cr.reward} · 积分 +${cr.points}`
                : '通关（奖励已在首次通关时领取）'
              : cr.won
                ? '获胜，但没有达成通关条件'
                : '未通关，再试一次'}
          </div>
        </div>
      )}
      <div className="me-rounds">
        {rounds.map((r, i) => (
          <span key={i} className={`me-round ${r.outcome.kind === 'draw' ? 'draw' : r.outcome.winner === 'player' ? 'win' : 'lose'}`} title={r.text}>
            {r.outcome.kind === 'draw' ? '平' : `${FINISH_ICON[r.outcome.finish!]}${r.outcome.points}`}
          </span>
        ))}
      </div>
      <div className="me-stats">
        <StatCell label="接触" value={`${sum((r) => r.stats.contacts)} 次`} />
        <StatCell label="最大冲击" value={`${maxImp.toFixed(1)}`} />
        <StatCell label="爆裂应力峰值" value={peak.toFixed(2)} />
        <StatCell label="轨道冲刺" value={`${sum((r) => r.stats.dashes.player)} 次`} />
        <StatCell label="用时" value={`${sum((r) => r.stats.duration).toFixed(0)} 秒`} />
      </div>
      <div className="me-types">
        <TypeBadge role={s.player.role} small /> <span className="muted">对</span> <TypeBadge role={s.rival.role} small />
        <span className="muted"> · 分值：自转 {FINISH_POINTS.spin} / 出界 {FINISH_POINTS.over} / 爆裂 {FINISH_POINTS.burst} / 极限 {FINISH_POINTS.xtreme}</span>
      </div>
      <div className="me-actions">
        {cr?.next && (
          <button className="btn primary" onClick={() => engine.nextChallenge()} data-testid="next-level">
            下一关 ›
          </button>
        )}
        <button className={`btn ${cr?.next ? '' : 'primary'}`} onClick={() => engine.rematch()} data-testid="again">
          {cr ? (cr.cleared ? '再挑战一次' : '再试一次') : '重赛'}
        </button>
        <button className="btn" onClick={() => engine.openGarage()} data-testid="me-garage">
          换构筑
        </button>
        <button className="btn ghost" onClick={() => engine.toTitle()} data-testid="me-home">
          返回
        </button>
      </div>
    </div>
  );
}
