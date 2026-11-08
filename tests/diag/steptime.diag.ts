import { appendFileSync, mkdirSync } from 'node:fs';
import { test } from 'vitest';
import { BEY_TUNING } from '../../src/game/beys/BeyPhysics';
if (process.env.DIAG_TUNE) Object.assign(BEY_TUNING, JSON.parse(process.env.DIAG_TUNE));
import { createArenaPhysics } from '../../src/game/arena/ArenaPhysics';
import { BattleSystem } from '../../src/game/battle/BattleSystem';
import { PLAYER_LOADOUT, RIVAL_LOADOUT } from '../../src/game/beys/parts/catalog';
import { assembleBey } from '../../src/game/beys/parts/assemble';
import { loadRapier, PhysicsWorld } from '../../src/game/physics/PhysicsWorld';

/** 物理步耗时分解：world.step / 自定义 preStep / postStep（Node，同一台机器上新旧对比） */
test('step time', async () => {
  const R = await loadRapier();
  let pre = 0, world = 0, post = 0, steps = 0;
  for (let run = 0; run < 4; run++) {
    const pw = new PhysicsWorld(R);
    createArenaPhysics(pw);
    const battle = new BattleSystem(pw, { player: assembleBey(PLAYER_LOADOUT), rival: assembleBey(RIVAL_LOADOUT) });
    pw.beforeStep = (dt) => { const t = performance.now(); battle.preStep(dt); pre += performance.now() - t; };
    pw.afterStep = (dt) => { const t = performance.now(); battle.postStep(dt); post += performance.now() - t; };
    battle.launch('player', { power: 0.85, aim: (run - 1.5) * 0.2, tilt: 0 });
    battle.launch('rival', { power: 0.8, aim: 0, tilt: 0 });
    for (let i = 0; i < 120 * 15 && !battle.result; i++) {
      const t = performance.now();
      pw.step();
      world += performance.now() - t;
      steps++;
    }
    pw.dispose();
  }
  world -= pre + post;
  const colliders = (() => { const pw = new PhysicsWorld(R); createArenaPhysics(pw); const n = pw.world.colliders.len(); pw.dispose(); return n; })();
  mkdirSync('test-results/diag', { recursive: true });
  appendFileSync('test-results/diag/steptime.md', `| ${process.env.DIAG_LABEL ?? 'current'} | ${steps} | ${(world / steps).toFixed(3)} | ${(pre / steps).toFixed(3)} | ${(post / steps).toFixed(3)} | ${((world + pre + post) / steps).toFixed(3)} | ${colliders} |\n`);
});
