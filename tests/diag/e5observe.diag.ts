/**
 * E5 路径调查：只读观测针尖对针尖确认僵持期间 MotionIntent 与进动相关的状态（不施加任何覆盖）。
 *   E5_OBS_OUT=文件（默认 test-results/e5/observe.json）
 * 确认僵持口径与 e5authority.diag.ts 相同。记录：意图状态、authority、heading 与对手方向夹角、edgeW、
 * knocked（相位跟随实际倾斜）、自稳强度是否 > 0、实际进动角速度与自然进动角速度之比。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { test } from 'vitest';
import { BEY_TUNING } from '../../src/game/beys/BeyPhysics';
import { loadRapier, PHYSICS_DT } from '../../src/game/physics/PhysicsWorld';
import { seeded } from '../motion/motionSim';
import { scenariosV2, setup } from './stallprobe2.shared';

test('E5 observe', async () => {
  const R = await loadRapier();
  const out = process.env.E5_OBS_OUT ?? 'test-results/e5/observe.json';
  mkdirSync(dirname(out), { recursive: true });
  const states: Record<string, number> = {};
  const auth: number[] = [];
  const headOpp: number[] = [];
  const rateRatio: number[] = [];
  let steps = 0;
  let edge = 0;
  let knocked = 0;
  let noUpright = 0;
  for (const sc of scenariosV2()) {
    const orig = Math.random;
    Math.random = seeded(sc.seed);
    try {
      const { pw, b, A, B } = setup(R, sc);
      const beys = [A, B];
      if (!beys.every((x) => x.spec.tip.gearGrip < 0.2)) {
        pw.dispose();
        continue;
      }
      let miss = 99;
      let dwell = 0;
      const max = (sc.maxSeconds ?? 60) / PHYSICS_DT;
      for (let s = 0; s < max && !b.result; s++) {
        const k = b.contactClass;
        miss = k.geometric || k.impulseResponse ? 0 : miss + 1;
        const ok = miss > 6 && beys.every((x) => Math.hypot(x.body.linvel().x, x.body.linvel().z) < 0.4 && x.spinRatio >= 0.4 && x.breakout <= 0) && b.wobbleFor === 0;
        dwell = ok ? dwell + PHYSICS_DT : 0;
        const p0 = beys.map((x) => (x as unknown as { precession: number }).precession);
        pw.step();
        if (dwell < 3) continue;
        beys.forEach((x, i) => {
          steps++;
          const it = x.intent;
          states[it.state] = (states[it.state] ?? 0) + 1;
          auth.push(it.authority);
          if (it.edgeW > 0) edge++;
          if (x.knocked) knocked++;
          const T = BEY_TUNING;
          if (x.spin <= T.minStableSpin) noUpright++;
          const o = beys[1 - i].body.translation();
          const p = x.body.translation();
          const bo = Math.atan2(o.z - p.z, o.x - p.x);
          headOpp.push((Math.abs(Math.atan2(Math.sin(it.heading - bo), Math.cos(it.heading - bo))) * 180) / Math.PI);
          const nat = T.precessBase + T.precessSpin / Math.max(20, x.spin);
          const dp = (x as unknown as { precession: number }).precession - p0[i];
          rateRatio.push(Math.abs(dp / PHYSICS_DT) / nat);
        });
      }
      pw.dispose();
    } finally {
      Math.random = orig;
    }
  }
  const q = (a: number[], p: number) => {
    const s = a.slice().sort((x, y) => x - y);
    return s[Math.floor(p * (s.length - 1))];
  };
  const st = (a: number[]) => ({ n: a.length, p10: q(a, 0.1), p50: q(a, 0.5), p90: q(a, 0.9), max: q(a, 1) });
  writeFileSync(out, JSON.stringify({ steps, states, authority: st(auth), authorityPositive: auth.filter((v) => v > 0).length, headingVsOpponentDeg: st(headOpp), rateOverNatural: st(rateRatio), edgeSteps: edge, knockedSteps: knocked, noUprightSteps: noUpright }, null, 1));
}, 7_200_000);
