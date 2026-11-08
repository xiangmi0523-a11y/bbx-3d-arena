import { createArenaPhysics } from '../src/game/arena/ArenaPhysics';
import { BattleSystem } from '../src/game/battle/BattleSystem';
import { assembleBey } from '../src/game/beys/parts/assemble';
import type { BeyLoadout } from '../src/game/beys/parts/types';
import { rivalCommand } from '../src/game/launcher/launch';
import { loadRapier, PhysicsWorld, PHYSICS_DT } from '../src/game/physics/PhysicsWorld';

/**
 * P2.3.1 战斗手感统计（真实物理，无头）：速度、撞击、贴身接触、僵持（两台都几乎不动、贴在一起仍在转）。
 * 单元测试和 tests/diag/feel.diag.ts 共用。
 */
/** 可复现的伪随机（进动初相、对手发射都用 Math.random） */
export function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface FeelRun {
  duration: number;
  result: string;
  meanSpeed: number;
  fastFrac: number;
  hits: number;
  strong: number;
  grinds: number;
  contactFrac: number;
  longestContact: number;
  stall: number;
  longestStall: number;
  dvMedian: number;
}

export async function feelRun(lo: { player: BeyLoadout; rival: BeyLoadout }, seed: number, maxSeconds = 60): Promise<FeelRun> {
  const orig = Math.random;
  Math.random = seeded(seed);
  try {
    const R = await loadRapier();
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
    let steps = 0;
    let speedSum = 0;
    let fast = 0;
    let contact = 0;
    let curContact = 0;
    let longestContact = 0;
    let stall = 0;
    let curStall = 0;
    let longestStall = 0;
    const max = maxSeconds / PHYSICS_DT;
    for (; steps < max && !battle.result; steps++) {
      pw.step();
      const pa = A.body.translation();
      const pb = B.body.translation();
      const va = A.body.linvel();
      const vb = B.body.linvel();
      const sa = Math.hypot(va.x, va.z);
      const sb = Math.hypot(vb.x, vb.z);
      speedSum += (sa + sb) / 2;
      if (sa > 3) fast += 0.5;
      if (sb > 3) fast += 0.5;
      const d = Math.hypot(pa.x - pb.x, pa.z - pb.z);
      const touching = d < A.spec.blade.radius + B.spec.blade.radius + 0.03;
      if (touching) {
        contact++;
        curContact += PHYSICS_DT;
        longestContact = Math.max(longestContact, curContact);
      } else curContact = 0;
      // 僵持 = 两台都几乎不动、贴在一起或相距很近，仍在转
      const stalled = sa < 0.8 && sb < 0.8 && d < A.spec.blade.radius + B.spec.blade.radius + 0.4 && A.spin > 10 && B.spin > 10;
      if (stalled) {
        stall += PHYSICS_DT;
        curStall += PHYSICS_DT;
        longestStall = Math.max(longestStall, curStall);
      } else curStall = 0;
    }
    const dv = battle.impacts.map((e) => e.dvRel).sort((a, b) => a - b);
    const out: FeelRun = {
      duration: battle.time,
      result: battle.result ? `${battle.result.winner}:${battle.result.finish}` : 'timeout',
      meanSpeed: speedSum / steps,
      fastFrac: fast / steps,
      hits: battle.hits,
      strong: battle.impacts.filter((e) => e.tier !== 'light').length,
      grinds: battle.grinds,
      contactFrac: contact / steps,
      longestContact,
      stall,
      longestStall,
      dvMedian: dv.length ? dv[Math.floor(dv.length / 2)] : NaN,
    };
    pw.dispose();
    return out;
  } finally {
    Math.random = orig;
  }
}

