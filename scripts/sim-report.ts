import { simulateBattle } from '../tests/sim';
const seeds = [
  { player: { power: 1, aim: 0, tilt: 0 }, rival: { power: 0.8, aim: 0, tilt: 0 } },
  { player: { power: 0.5, aim: 0.5, tilt: 0 }, rival: { power: 0.9, aim: -0.4, tilt: 0 } },
  { player: { power: 0.3, aim: -1, tilt: 0 }, rival: { power: 0.6, aim: 0.6, tilt: 0 } },
  { player: { power: 0.9, aim: 1, tilt: 0 }, rival: { power: 0.95, aim: 0, tilt: 0 } },
];
for (const s of seeds) {
  const verbose = process.argv.includes('-v');
  const r = await simulateBattle({ ...s, trace: verbose ? (t, b) => {
    const f = (k: 'player'|'rival') => { const x = b.beys[k]!; const p = x.body.translation(); return `${k[0]} r=${Math.hypot(p.x,p.z).toFixed(2)} y=${p.y.toFixed(2)} spin=${x.spin.toFixed(0)} tilt=${(x.tilt*57).toFixed(0)} v=${Math.hypot(x.body.linvel().x,x.body.linvel().z).toFixed(1)}${x.dashing?' DASH':''}`; };
    console.log(t.toFixed(1), f('player'), '|', f('rival'), 'hits', b.hits);
  } : undefined });
  console.log(JSON.stringify(s.player), '=>', r.battle.result, 'hits', r.battle.hits, 'steps', r.steps);
  r.dispose();
}
