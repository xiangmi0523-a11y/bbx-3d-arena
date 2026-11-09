import { createArenaPhysics } from '../src/game/arena/ArenaPhysics';
import { BattleSystem } from '../src/game/battle/BattleSystem';
import { PLAYER_LOADOUT, RIVAL_LOADOUT } from '../src/game/beys/parts/catalog';
import { assembleBey } from '../src/game/beys/parts/assemble';
import { loadRapier, PhysicsWorld } from '../src/game/physics/PhysicsWorld';
import type { LaunchCommand } from '../src/game/launcher/PullStringGesture';
import type { BeyLoadout } from '../src/game/beys/parts/types';
import { defaultSeed, withDeterminism } from './repro/determinism';

export interface SimOptions {
  player: LaunchCommand;
  rival: LaunchCommand;
  maxSeconds?: number;
  playerLoadout?: BeyLoadout;
  rivalLoadout?: BeyLoadout;
  trace?: (t: number, b: BattleSystem) => void;
  /** trace 每隔多少个物理步调用一次（默认 60 步 = 0.5 秒） */
  every?: number;
  /**
   * 随机种子（进动初相、战术意图种子）。省略时由发射参数、部件和时长派生（defaultSeed），
   * 同一组参数每次运行结果相同；REPRO_SEED_SALT 可整体换一组种子做稳健性抽查。
   */
  seed?: number | null;
}

/** 无头模拟一整场对战（不渲染），返回战斗系统 */
export async function simulateBattle(opts: SimOptions) {
  const R = await loadRapier();
  const pw = new PhysicsWorld(R);
  createArenaPhysics(pw);
  const battle = new BattleSystem(pw, {
    player: assembleBey(opts.playerLoadout ?? PLAYER_LOADOUT),
    rival: assembleBey(opts.rivalLoadout ?? RIVAL_LOADOUT),
  });
  pw.beforeStep = (dt) => battle.preStep(dt);
  pw.afterStep = (dt) => battle.postStep(dt);
  // 随机数只在构造陀螺时消耗（进动初相、意图种子）；逐步推进不调用 Math.random（tests/repro.test.ts 验证）
  const launch = () => {
    battle.launch('player', opts.player);
    battle.launch('rival', opts.rival);
  };
  // seed: null = 沿用调用方当前的全局 Math.random（旧诊断脚本自行替换 Math.random 时使用）
  if (opts.seed === null) launch();
  else withDeterminism(opts.seed ?? defaultSeed(opts), launch);
  const max = (opts.maxSeconds ?? 130) * 120;
  let steps = 0;
  let maxAbs = 0;
  const impactLog: { t: number; tier: string; strength: number }[] = [];
  let seen = 0;
  for (; steps < max && !battle.result; steps++) {
    pw.step();
    for (; seen < battle.impacts.length; seen++) {
      const e = battle.impacts[seen];
      impactLog.push({ t: (steps + 1) / 120, tier: e.tier, strength: e.strength });
    }
    for (const b of Object.values(battle.beys)) {
      const p = b!.body.translation();
      maxAbs = Math.max(maxAbs, Math.abs(p.x), Math.abs(p.z));
    }
    if (opts.trace && steps % (opts.every ?? 60) === 0) opts.trace(steps / 120, battle);
  }
  const out = { battle, steps, maxAbs, impactLog };
  return { ...out, step: () => pw.step(), dispose: () => pw.dispose() };
}
