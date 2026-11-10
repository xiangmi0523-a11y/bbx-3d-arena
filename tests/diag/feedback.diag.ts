import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'vitest';
import { createArenaPhysics } from '../../src/game/arena/ArenaPhysics';
import { BattleSystem } from '../../src/game/battle/BattleSystem';
import { CONTACT_TUNING } from '../../src/game/battle/contactFeedback';
import { assembleBey } from '../../src/game/beys/parts/assemble';
import { PLAYER_LOADOUT, RIVAL_LOADOUT } from '../../src/game/beys/parts/catalog';
import type { BeyLoadout } from '../../src/game/beys/parts/types';
import { rivalCommand } from '../../src/game/launcher/launch';
import { loadRapier, PhysicsWorld, PHYSICS_DT } from '../../src/game/physics/PhysicsWorld';
import { seeded } from '../feelSim';
if (process.env.DIAG_CONTACT) Object.assign(CONTACT_TUNING, JSON.parse(process.env.DIAG_CONTACT));

/**
 * 三层接触反馈在真实对战里的分布（固定种子，无头）：
 *   npx vitest run --config vitest.diag.config.ts tests/diag/feedback.diag.ts
 * 输出：接触段数、进入持续摩擦的段数、各层时间占比、摩擦强度分布、被合并的强碰撞、
 * “两台贴身（外缘间距 < 8 cm）却 0.15 秒内没有任何反馈”的时间占比（旧版 / 新版）。
 */
const MATCHUPS: Record<string, { player: BeyLoadout; rival: BeyLoadout }> = {
  默认: { player: PLAYER_LOADOUT, rival: RIVAL_LOADOUT },
  平衡套装: { player: { blade: 'gale-crescent', ratchet: 'hex-lock', bit: 'dome-ball' }, rival: RIVAL_LOADOUT },
  攻击对防御: {
    player: { blade: 'blaze-fang', ratchet: 'tri-lock', bit: 'rush-rubber' },
    rival: { blade: 'tidal-bastion', ratchet: 'ring-guard', bit: 'dome-ball' },
  },
  同攻击: { player: PLAYER_LOADOUT, rival: { blade: 'blaze-fang', ratchet: 'tri-lock', bit: 'rush-rubber' } },
};

test('feedback layers', async () => {
  const N = Number(process.env.DIAG_N ?? 6);
  const R = await loadRapier();
  const out: Record<string, unknown> = {};
  for (const [name, lo] of Object.entries(MATCHUPS)) {
    let total = 0, grindT = 0, grazeT = 0, near = 0, nearNoOld = 0, nearNoNew = 0;
    let episodes = 0, grindEp = 0, merged = 0, absorbed = 0, strong = 0, light = 0, hits = 0;
    const levels: number[] = [];
    const grindLens: number[] = [];
    for (let i = 0; i < N; i++) {
      const orig = Math.random;
      Math.random = seeded(1000 + i);
      const pw = new PhysicsWorld(R);
      createArenaPhysics(pw);
      const battle = new BattleSystem(pw, { player: assembleBey(lo.player), rival: assembleBey(lo.rival) });
      pw.beforeStep = (dt) => battle.preStep(dt);
      pw.afterStep = (dt) => battle.postStep(dt);
      const rnd = Math.random;
      battle.launch('player', { power: 0.6 + rnd() * 0.35, aim: (rnd() - 0.5) * 0.8, tilt: 0 });
      battle.launch('rival', rivalCommand(rnd));
      const A = battle.beys.player!;
      const B = battle.beys.rival!;
      let lastEv = -9, lastAny = -9, curGrind = 0;
      for (let s = 0; s < 60 / PHYSICS_DT && !battle.result; s++) {
        const n0 = battle.impacts.length;
        pw.step();
        total += PHYSICS_DT;
        for (const e of battle.impacts.slice(n0)) {
          if (e.feedback !== 'play') continue;
          lastEv = battle.time;
          if (e.tier === 'light') light++; else strong++;
        }
        const c = battle.contact.state;
        if (c.phase === 'grind') { grindT += PHYSICS_DT; curGrind += PHYSICS_DT; } else { if (curGrind > 0) grindLens.push(curGrind); curGrind = 0; }
        if (c.phase === 'graze') grazeT += PHYSICS_DT;
        if (c.level > 0.03) { levels.push(c.level); lastAny = battle.time; }
        const pa = A.body.translation(), pb = B.body.translation();
        const d = Math.hypot(pa.x - pb.x, pa.z - pb.z) - A.spec.outerRadius - B.spec.outerRadius;
        if (d < 0.08) {
          near += PHYSICS_DT;
          if (battle.time - lastEv > 0.15) nearNoOld += PHYSICS_DT;
          if (battle.time - Math.max(lastEv, lastAny) > 0.15) nearNoNew += PHYSICS_DT;
        }
      }
      if (curGrind > 0) grindLens.push(curGrind);
      episodes += battle.contact.episodes;
      grindEp += battle.contact.grindEpisodes;
      merged += battle.contact.merged;
      absorbed += battle.contact.absorbed;
      hits += battle.hits;
      pw.dispose();
      Math.random = orig;
    }
    const q = (a: number[], k: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? +s[Math.min(s.length - 1, Math.floor(s.length * k))].toFixed(3) : NaN; };
    out[name] = {
      seconds: +total.toFixed(1),
      episodes, grindEpisodes: grindEp, merged, absorbed, hits, strongPlayed: strong, lightPlayed: light,
      grindFrac: +(grindT / total).toFixed(4), grazeFrac: +(grazeT / total).toFixed(4),
      grindLenP50: q(grindLens, 0.5), grindLenMax: q(grindLens, 1),
      levelP10: q(levels, 0.1), levelP50: q(levels, 0.5), levelP90: q(levels, 0.9), levelMax: q(levels, 1),
      nearFrac: +(near / total).toFixed(4),
      nearNoFeedbackOld: +(nearNoOld / Math.max(1e-9, near)).toFixed(3),
      nearNoFeedbackNew: +(nearNoNew / Math.max(1e-9, near)).toFixed(3),
    };
  }
  mkdirSync('test-results/diag', { recursive: true });
  writeFileSync(`test-results/diag/feedback-${process.env.DIAG_LABEL ?? 'now'}.json`, JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
});
