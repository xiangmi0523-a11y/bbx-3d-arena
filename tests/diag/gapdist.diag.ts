import { writeFileSync } from 'node:fs';
import { test } from 'vitest';
import { createArenaPhysics } from '../../src/game/arena/ArenaPhysics';
import { BattleSystem } from '../../src/game/battle/BattleSystem';
import type { BeyPhysics } from '../../src/game/beys/BeyPhysics';
import { assembleBey } from '../../src/game/beys/parts/assemble';
import { PLAYER_LOADOUT, RIVAL_LOADOUT } from '../../src/game/beys/parts/catalog';
import { rivalCommand } from '../../src/game/launcher/launch';
import { loadRapier, PhysicsWorld, PHYSICS_DT } from '../../src/game/physics/PhysicsWorld';
import { seeded } from '../feelSim';

/** 刀刃高度处的水平外缘间距分布（按刚体姿态把刀刃中心算出来），以及真实接触时的间距 */
function bladeCenter(b: BeyPhysics) {
  const p = b.body.translation();
  const q = b.body.rotation();
  // 旋转 (0,1,0)
  const ux = 2 * (q.x * q.y - q.w * q.z);
  const uy = 1 - 2 * (q.x * q.x + q.z * q.z);
  const uz = 2 * (q.y * q.z + q.w * q.x);
  const h = b.spec.layers.blade.center;
  return { x: p.x + ux * h, y: p.y + uy * h, z: p.z + uz * h };
}
test('gap distribution', async () => {
  const R = await loadRapier();
  const bins = [-0.02, 0, 0.01, 0.02, 0.035, 0.05, 0.08];
  const hist = new Array(bins.length).fill(0);
  const touchHist = new Array(bins.length).fill(0);
  let total = 0;
  const dys: number[] = [];
  let ovT = 0, penT = 0, penNoImp = 0, manifoldNear = 0, noManifold = 0;
  const dyt: number[] = [];
  for (let i = 0; i < 6; i++) {
    const orig = Math.random;
    Math.random = seeded(1000 + i);
    const pw = new PhysicsWorld(R);
    createArenaPhysics(pw);
    const battle = new BattleSystem(pw, { player: assembleBey(PLAYER_LOADOUT), rival: assembleBey(RIVAL_LOADOUT) });
    pw.beforeStep = (dt) => battle.preStep(dt);
    pw.afterStep = (dt) => battle.postStep(dt);
    const rnd = Math.random;
    battle.launch('player', { power: 0.6 + rnd() * 0.35, aim: (rnd() - 0.5) * 0.8, tilt: 0 });
    battle.launch('rival', rivalCommand(rnd));
    const A = battle.beys.player!, B = battle.beys.rival!;
    for (let s = 0; s < 60 / PHYSICS_DT && !battle.result; s++) {
      pw.step();
      total += PHYSICS_DT;
      const ca = bladeCenter(A), cb = bladeCenter(B);
      const g = Math.hypot(ca.x - cb.x, ca.z - cb.z) - A.spec.outerRadius - B.spec.outerRadius;
      let imp = 0;
      let pen = false;
      let minDist = 9;
      for (const x of A.colliders) for (const y of B.colliders) pw.world.contactPair(x, y, (m) => { for (let k = 0; k < m.numContacts(); k++) { imp += m.contactImpulse(k); minDist = Math.min(minDist, m.contactDist(k)); if (m.contactDist(k) <= 0) pen = true; } });
      if (g < 0) { ovT += PHYSICS_DT; if (pen) penT += PHYSICS_DT; if (pen && imp <= 0) penNoImp += PHYSICS_DT; if (minDist < 9 && !pen) manifoldNear += PHYSICS_DT; if (minDist >= 9) noManifold += PHYSICS_DT; }
      if (g < 0 && imp <= 0) dys.push(Math.abs(ca.y - cb.y));
      if (g < 0 && imp > 0) dyt.push(Math.abs(ca.y - cb.y));
      for (let k = bins.length - 1; k >= 0; k--) if (g >= bins[k] || k === 0) { if (g < 0.11) { hist[k] += PHYSICS_DT; if (imp > 0) touchHist[k] += PHYSICS_DT; } break; }
    }
    pw.dispose();
    Math.random = orig;
  }
  const q = (a: number[], k: number) => { const t = [...a].sort((x, y) => x - y); return t.length ? t[Math.floor(t.length * k)].toFixed(3) : '-'; };
  const lines = ['total ' + total.toFixed(1), `overlap ${ovT.toFixed(2)}s pen ${penT.toFixed(2)} penNoImp ${penNoImp.toFixed(2)} manifoldPositiveDist ${manifoldNear.toFixed(2)} noManifold ${noManifold.toFixed(2)}`, `overlap-no-touch dy P10 ${q(dys, 0.1)} P50 ${q(dys, 0.5)} P90 ${q(dys, 0.9)} n=${dys.length}`, `overlap-touch dy P10 ${q(dyt, 0.1)} P50 ${q(dyt, 0.5)} P90 ${q(dyt, 0.9)} n=${dyt.length}`, `bladeH ${assembleBey(PLAYER_LOADOUT).layers.blade.center.toFixed(3)} ${assembleBey(RIVAL_LOADOUT).layers.blade.center.toFixed(3)} bladeHeight ${assembleBey(PLAYER_LOADOUT).blade.height} disc ${JSON.stringify(assembleBey(PLAYER_LOADOUT).layers)}`];
  bins.forEach((b, k) => lines.push([`gap>=${b}`, (hist[k] / total * 100).toFixed(2) + '%', 'touching', (touchHist[k] / total * 100).toFixed(2) + '%'].join(' ')));
  writeFileSync('test-results/diag/gapdist.txt', lines.join('\n'));
});
