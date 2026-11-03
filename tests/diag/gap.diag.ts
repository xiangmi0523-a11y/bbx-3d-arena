import { appendFileSync, writeFileSync } from 'node:fs';
import { test } from 'vitest';
import { BEY_TUNING } from '../../src/game/beys/BeyPhysics';
import { ARENA } from '../../src/game/arena/arenaSpec';
if (process.env.DIAG_TUNE) Object.assign(BEY_TUNING, JSON.parse(process.env.DIAG_TUNE));
if (process.env.DIAG_ARENA) Object.assign(ARENA, JSON.parse(process.env.DIAG_ARENA));
import { simulateBattle } from '../sim';
test('gap', async () => {
  const out = 'test-results/diag/gap.txt';
  writeFileSync(out, '');
  for (let i = 0; i < 12; i++) {
    const aim = ((i % 3) - 1) * 0.3;
    const rows: string[] = [];
    const r = await simulateBattle({
      player: { power: 0.7 + (i % 3) * 0.15, aim, tilt: 0 },
      rival: { power: 0.8, aim: -aim, tilt: 0 },
      maxSeconds: 40,
      trace: (t, b) => {
        if (Math.abs(t * 2 - Math.round(t * 2)) > 0.004) return;
        const f = (s: 'player' | 'rival') => {
          const x = b.beys[s]!;
          const p = x.body.translation();
          const v = x.body.linvel();
          return `r=${Math.hypot(p.x, p.z).toFixed(2)} v=${Math.hypot(v.x, v.z).toFixed(2)} s=${x.spin.toFixed(0)}`;
        };
        rows.push(`${t.toFixed(1)} P ${f('player')} | R ${f('rival')}`);
      },
    });
    const ts = r.impactLog.map((e) => e.t);
    let last = 1.5, g = 0, g0 = 0;
    for (const t of ts.filter((t) => t > 1.5)) { if (t - last > g) { g = t - last; g0 = last; } last = t; }
    appendFileSync(out, `battle ${i} dur ${r.battle.time.toFixed(1)} maxgap ${g.toFixed(1)} from ${g0.toFixed(1)} result ${JSON.stringify(r.battle.result)}\n`);
    if (g > 7) appendFileSync(out, rows.filter((l) => { const t = Number(l.split(' ')[0]); return t >= g0 && t <= g0 + g; }).join('\n') + '\n');
    r.dispose();
  }
});
