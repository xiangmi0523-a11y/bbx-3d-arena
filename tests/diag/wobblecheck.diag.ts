/**
 * 死亡摇摆脱离（第二轮修正 4）触发明细：每次触发时较弱一台的转速比例、倾斜、较强一台的转速比例；
 * 并统计「高转速持续摩擦」（双方转速比例都 > 0.5、贴靠 > 0.8 s）出现的次数，确认这些段落没有触发。WC_OUT 输出。
 */
import { writeFileSync } from 'node:fs';
import { test } from 'vitest';
import { createArenaPhysics } from '../../src/game/arena/ArenaPhysics';
import { BattleSystem } from '../../src/game/battle/BattleSystem';
import { assembleBey } from '../../src/game/beys/parts/assemble';
import { loadRapier, PhysicsWorld, PHYSICS_DT } from '../../src/game/physics/PhysicsWorld';
import { seeded } from '../motion/motionSim';
import { groups } from '../motion/scenarios';
test('wobble check', async () => {
  const R = await loadRapier();
  const trig: Record<string, unknown>[] = [];
  let hiGrind = 0;
  let hiGrindTrig = 0;
  let runs = 0;
  for (const g of groups().filter((x) => ['AvD', 'DvA', 'SvA', 'BvB', 'AvA', 'DFLT', 'POWER'].includes(x.key))) {
    for (const sc of g.scenarios) {
      runs++;
      const orig = Math.random;
      Math.random = seeded(sc.seed);
      const pw = new PhysicsWorld(R);
      createArenaPhysics(pw);
      const b = new BattleSystem(pw, { player: assembleBey(sc.player), rival: assembleBey(sc.rival) });
      pw.beforeStep = (dt) => b.preStep(dt);
      pw.afterStep = (dt) => b.postStep(dt);
      const A = b.launch('player', sc.pCmd);
      const B = b.launch('rival', sc.rCmd);
      let prev = 0;
      let hiFor = 0;
      let inHi = false;
      for (let i = 0; i < 60 / PHYSICS_DT && !b.result; i++) {
        pw.step();
        const pa = A.body.translation();
        const pb = B.body.translation();
        const touching = Math.hypot(pa.x - pb.x, pa.z - pb.z) < A.spec.blade.radius + B.spec.blade.radius + 0.05;
        const hi = touching && A.spinRatio > 0.5 && B.spinRatio > 0.5;
        hiFor = hi ? hiFor + PHYSICS_DT : 0;
        if (hiFor > 0.8 && !inHi) {
          inHi = true;
          hiGrind++;
        }
        if (!hi) inHi = false;
        if (b.wobbleBreaks > prev) {
          prev = b.wobbleBreaks;
          const low = A.spinRatio <= B.spinRatio ? A : B;
          const high = low === A ? B : A;
          if (inHi) hiGrindTrig++;
          trig.push({ name: sc.name, t: +(i * PHYSICS_DT).toFixed(2), lowSpin: +low.spinRatio.toFixed(3), lowTiltDeg: +((low.tilt * 180) / Math.PI).toFixed(1), lowDriftDeg: +((low.spec.bit.drift * 180) / Math.PI).toFixed(1), highSpin: +high.spinRatio.toFixed(3) });
        }
      }
      Math.random = orig;
      pw.dispose();
    }
  }
  writeFileSync(process.env.WC_OUT ?? 'test-results/motion/wobblecheck.json', JSON.stringify({ runs, triggers: trig.length, hiGrind, hiGrindTrig, maxLowSpin: Math.max(0, ...trig.map((x) => x.lowSpin as number)), minLowTilt: Math.min(99, ...trig.map((x) => x.lowTiltDeg as number)), trig }, null, 1));
}, 1200000);
