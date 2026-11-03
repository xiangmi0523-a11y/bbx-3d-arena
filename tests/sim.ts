import { createArenaPhysics } from '../src/game/arena/ArenaPhysics';
import { BattleSystem } from '../src/game/battle/BattleSystem';
import { PLAYER_LOADOUT, RIVAL_LOADOUT } from '../src/game/beys/parts/catalog';
import { assembleBey } from '../src/game/beys/parts/assemble';
import { loadRapier, PhysicsWorld } from '../src/game/physics/PhysicsWorld';
import type { LaunchCommand } from '../src/game/launcher/PullStringGesture';

export interface SimOptions {
  player: LaunchCommand;
  rival: LaunchCommand;
  maxSeconds?: number;
  trace?: (t: number, b: BattleSystem) => void;
}

/** 无头模拟一整场对战（不渲染），返回战斗系统 */
export async function simulateBattle(opts: SimOptions) {
  const R = await loadRapier();
  const pw = new PhysicsWorld(R);
  createArenaPhysics(pw);
  const battle = new BattleSystem(pw, { player: assembleBey(PLAYER_LOADOUT), rival: assembleBey(RIVAL_LOADOUT) });
  pw.beforeStep = (dt) => battle.preStep(dt);
  pw.afterStep = (dt) => battle.postStep(dt);
  battle.launch('player', opts.player);
  battle.launch('rival', opts.rival);
  const max = (opts.maxSeconds ?? 130) * 120;
  let steps = 0;
  let maxAbs = 0;
  for (; steps < max && !battle.result; steps++) {
    pw.step();
    for (const b of Object.values(battle.beys)) {
      const p = b!.body.translation();
      maxAbs = Math.max(maxAbs, Math.abs(p.x), Math.abs(p.z));
    }
    if (opts.trace && steps % 60 === 0) opts.trace(steps / 120, battle);
  }
  const out = { battle, steps, maxAbs };
  return { ...out, dispose: () => pw.dispose() };
}
