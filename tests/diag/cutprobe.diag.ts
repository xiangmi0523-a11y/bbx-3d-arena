/** 逐步打印一台陀螺的意图内部量（状态、调制深度、期望方向与牵引方向夹角、预测掠过偏移等）。P=场景名 SIDE=rival T=秒 O=输出文件 */
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
test('probe', async () => {
  const sc = groups().flatMap((g) => g.scenarios).find((s) => s.name === (process.env.P ?? 'AvD#0'))!;
  const orig = Math.random;
  Math.random = seeded(sc.seed);
  const R = await loadRapier();
  const pw = new PhysicsWorld(R);
  createArenaPhysics(pw);
  const b = new BattleSystem(pw, { player: assembleBey(sc.player), rival: assembleBey(sc.rival) });
  pw.beforeStep = (dt) => b.preStep(dt);
  pw.afterStep = (dt) => b.postStep(dt);
  const P0 = b.launch('player', sc.pCmd);
  const R0 = b.launch('rival', sc.rCmd);
  const [A, B] = process.env.SIDE === 'rival' ? [R0, P0] : [P0, R0];
  const lines: string[] = [];
  for (let i = 0; i < (Number(process.env.T ?? 12) / PHYSICS_DT) && !b.result; i++) {
    pw.step();
    if (i % 3) continue;
    const pa = A.body.translation(), pb = B.body.translation(), va = A.body.linvel(), vb = B.body.linvel();
    const dx = pb.x - pa.x, dz = pb.z - pa.z, d = Math.hypot(dx, dz);
    const it = A.intent as unknown as { state: string; authority: number; heading: number; side: number; cutAngle: number };
    const prec = (A as unknown as { precession: number }).precession;
    const sgn = (A as unknown as { spinSign: number }).spinSign;
    const drive = prec + (sgn * Math.PI) / 2;
    const ux = dx / d, uz = dz / d, nx = -uz, nz = ux;
    const rvx = va.x - vb.x, rvz = va.z - vb.z, vr2 = rvx * rvx + rvz * rvz, cl = rvx * ux + rvz * uz;
    const ts = Math.max(0.05, Math.min(1.5, (cl * d) / Math.max(vr2, 1e-6)));
    const s = (-dx + rvx * ts) * nx + (-dz + rvz * ts) * nz;
    const w = (x: number) => Math.atan2(Math.sin(x), Math.cos(x));
    lines.push(`${((i + 1) * PHYSICS_DT).toFixed(2)} ${it.state.padEnd(9)} d ${d.toFixed(2)} a ${it.authority.toFixed(2)} hd-drive ${(w(it.heading - drive) * 57.3).toFixed(0).padStart(4)}° vA ${Math.hypot(va.x, va.z).toFixed(1)} cl ${cl.toFixed(1)} t* ${ts.toFixed(2)} s ${s.toFixed(2)} want ${(it.side * Math.sin(it.cutAngle) * (A.spec.blade.radius + B.spec.blade.radius)).toFixed(2)} r ${Math.hypot(pa.x, pa.z).toFixed(1)} spin ${A.spinRatio.toFixed(2)} grnd ${A.grounded ? 1 : 0} tilt ${(A.tilt * 57.3).toFixed(0)} kn ${A.knocked ? 1 : 0} prec ${(w(prec) * 57.3).toFixed(0)}`);
  }
  Math.random = orig;
  writeFileSync(process.env.O ?? 'test-results/motion/probe.txt', lines.join('\n'));
});
