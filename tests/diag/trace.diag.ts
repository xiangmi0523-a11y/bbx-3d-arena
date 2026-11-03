import { appendFileSync, mkdirSync } from 'node:fs';
import { test } from 'vitest';
import { BEY_TUNING } from '../../src/game/beys/BeyPhysics';
import { SMASH_TUNING } from '../../src/game/battle/BattleSystem';
if (process.env.DIAG_TUNE) Object.assign(BEY_TUNING, JSON.parse(process.env.DIAG_TUNE));
if (process.env.DIAG_SMASH) Object.assign(SMASH_TUNING, JSON.parse(process.env.DIAG_SMASH));

import { simulateBattle } from '../sim';

test('trace', async () => {
  mkdirSync('test-results/diag', { recursive: true });
  const out = 'test-results/diag/trace.txt';
  const lo = process.env.TRACE_PLAYER ? JSON.parse(process.env.TRACE_PLAYER) : undefined;
  let lastHits = 0;
  const r = await simulateBattle({
    player: { power: 0.85, aim: 0, tilt: 0 },
    rival: { power: 0.8, aim: 0, tilt: 0 },
    playerLoadout: lo,
    maxSeconds: 60,
    trace: (t, b) => {
      if (Math.round(t * 2) % 1 !== 0) return;
      const f = (s: 'player' | 'rival') => {
        const x = b.beys[s]!;
        const p = x.body.translation();
        const v = x.body.linvel();
        return `r=${Math.hypot(p.x, p.z).toFixed(2)} v=${Math.hypot(v.x, v.z).toFixed(2)} spin=${x.spin.toFixed(0)} tilt=${x.tilt.toFixed(2)}${x.dashing ? ' DASH' : ''}`;
      };
      const pa = b.beys.player!.body.translation();
      const pb = b.beys.rival!.body.translation();
      appendFileSync(out, `t=${t.toFixed(1)} d=${Math.hypot(pa.x - pb.x, pa.z - pb.z).toFixed(2)} hits+${b.hits - lastHits} | P ${f('player')} | R ${f('rival')}\n`);
      lastHits = b.hits;
    },
  });
  appendFileSync(out, `result ${JSON.stringify(r.battle.result)}\n`);
  r.dispose();
});
