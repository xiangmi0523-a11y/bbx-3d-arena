/**
 * 发射方向是否被尊重：每个发射场景记录玩家陀螺 0.25 s / 0.5 s 时的水平速度方向与发射方向的夹角、速度大小，
 * 以及首次接触时间。DIAG_INTENT / DIAG_TUNE 覆盖调参，LD_OUT 输出 JSON。
 */
import { writeFileSync } from 'node:fs';
import { test } from 'vitest';
import { createArenaPhysics } from '../../src/game/arena/ArenaPhysics';
import { BattleSystem } from '../../src/game/battle/BattleSystem';
import { assembleBey } from '../../src/game/beys/parts/assemble';
import { INTENT_TUNING } from '../../src/game/beys/motionIntent';
import { BEY_TUNING } from '../../src/game/beys/BeyPhysics';
import { loadRapier, PhysicsWorld, PHYSICS_DT } from '../../src/game/physics/PhysicsWorld';
import { seeded } from '../motion/motionSim';
import { groups } from '../motion/scenarios';
if (process.env.DIAG_INTENT) Object.assign(INTENT_TUNING, JSON.parse(process.env.DIAG_INTENT));
if (process.env.DIAG_TUNE) Object.assign(BEY_TUNING, JSON.parse(process.env.DIAG_TUNE));
test('launch direction', async () => {
  const R = await loadRapier();
  const out: Record<string, unknown>[] = [];
  const keys = (process.env.LD_GROUPS ?? 'AIM,POWER,WALL,DFLT,AvD,DvA,SvA,BvB,AvA').split(',');
  for (const g of groups().filter((x) => keys.includes(x.key))) {
    for (const sc of g.scenarios) {
      const orig = Math.random;
      Math.random = seeded(sc.seed);
      const pw = new PhysicsWorld(R);
      createArenaPhysics(pw);
      const b = new BattleSystem(pw, { player: assembleBey(sc.player), rival: assembleBey(sc.rival) });
      pw.beforeStep = (dt) => b.preStep(dt);
      pw.afterStep = (dt) => b.postStep(dt);
      const A = b.launch('player', sc.pCmd);
      const B = b.launch('rival', sc.rCmd);
      const v0 = A.body.linvel();
      const h0 = Math.atan2(v0.z, v0.x);
      const rec: Record<string, number | string | null> = { name: sc.name, group: g.key, aim: sc.pCmd.aim, power: sc.pCmd.power, v0: Math.hypot(v0.x, v0.z), first: null };
      const contactR = A.spec.blade.radius + B.spec.blade.radius + 0.03;
      for (let i = 1; i <= Math.round(1.2 / PHYSICS_DT) && !b.result; i++) {
        pw.step();
        const t = i * PHYSICS_DT;
        const pa = A.body.translation();
        const pb = B.body.translation();
        if (rec.first === null && Math.hypot(pa.x - pb.x, pa.z - pb.z) < contactR) rec.first = t;
        for (const tt of [0.25, 0.5]) {
          if (Math.abs(t - tt) < PHYSICS_DT / 2) {
            const v = A.body.linvel();
            rec[`dev${tt}`] = (Math.atan2(Math.sin(Math.atan2(v.z, v.x) - h0), Math.cos(Math.atan2(v.z, v.x) - h0)) * 180) / Math.PI;
            rec[`sp${tt}`] = Math.hypot(v.x, v.z);
            rec[`touched${tt}`] = rec.first !== null ? 1 : 0;
          }
        }
      }
      Math.random = orig;
      out.push(rec);
    }
  }
  writeFileSync(process.env.LD_OUT ?? 'test-results/motion/ld.json', JSON.stringify(out));
}, 600000);
