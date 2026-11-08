/**
 * E5 前置核查：针尖对针尖确认僵持状态下，把 MotionIntent.authority 抬到下限（A 0 / B 0.3 / C 0.6）
 * 是否真的改变物理。诊断路径：只包装 intent.update，在原函数算完后把 authority 取 max(原值, 下限)；不改 src/。
 *   E5_OUT=文件（默认 test-results/e5/check.json）  E5_ALL=1 同时跑全部 180 场（隔离校验）
 *
 * 确认僵持（全部满足才生效，每步在 preStep 之前用上一步状态判定）：
 *  - 双方都是针尖（gearGrip < Stage A 牵引门槛 0.2）
 *  - 双方水平速度 < 0.4 m/s、几何接触与冲量响应结束 > 6 步（与 V2 WATCH(0.4) 同口径）
 *  - 双方转速比例 ≥ 0.4（低于 0.4 交给 Wobble 原有行为）、wobble 计时为 0、双方不在脱困
 *  - 以上持续 ≥ 3 s（V2：到 3 s 的针尖对针尖低速段 24/24 最终 ≥ 10 s）
 * 同时逐步记录“牵引门是否打开”（与 BeyPhysics.preStep 同式复算），因为 BeyPhysics 只在牵引门打开时才读取 authority。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { test } from 'vitest';
import { BEY_TUNING } from '../../src/game/beys/BeyPhysics';
import { loadRapier, PHYSICS_DT } from '../../src/game/physics/PhysicsWorld';
import { seeded } from '../motion/motionSim';
import { fingerprint, scenariosV2, setup } from './stallprobe2.shared';

const MODES = { A: 0, B: 0.3, C: 0.6 } as const;

test('E5 authority floor check', async () => {
  const R = await loadRapier();
  const out = process.env.E5_OUT ?? 'test-results/e5/check.json';
  mkdirSync(dirname(out), { recursive: true });
  const all = process.env.E5_ALL === '1';
  const runs: unknown[] = [];
  for (const sc of scenariosV2()) {
    for (const [mode, floor] of Object.entries(MODES)) {
      const orig = Math.random;
      Math.random = seeded(sc.seed);
      try {
        const { pw, b, A, B } = setup(R, sc);
        const beys = [A, B];
        const nn = beys.every((x) => x.spec.tip.gearGrip < 0.2);
        if (!nn && !all) {
          pw.dispose();
          continue;
        }
        let miss = 99;
        let dwell = 0;
        let confirmed = false;
        const st = { confirmedSteps: 0, raisedSteps: 0, gateOpenWhileConfirmed: 0, gateOpenWhileRaised: 0, steeringReachesPhysics: 0, rateDiffSteps: 0 };
        // 包装 intent.update：只在确认僵持时抬高 authority
        beys.forEach((x) => {
          const up = x.intent.update.bind(x.intent);
          x.intent.update = (inp) => {
            up(inp);
            if (confirmed && floor > 0 && x.intent.authority < floor) {
              x.intent.authority = floor;
              st.raisedSteps++;
            }
          };
        });
        const before = pw.beforeStep!;
        pw.beforeStep = (dt) => {
          const k = b.contactClass;
          miss = k.geometric || k.impulseResponse ? 0 : miss + 1;
          const ok =
            nn &&
            miss > 6 &&
            beys.every((x) => {
              const v = x.body.linvel();
              return Math.hypot(v.x, v.z) < 0.4 && x.spinRatio >= 0.4 && x.breakout <= 0;
            }) &&
            b.wobbleFor === 0;
          dwell = ok ? dwell + dt : 0;
          confirmed = dwell >= 3;
          if (confirmed) st.confirmedSteps++;
          const p0 = beys.map((x) => (x as unknown as { precession: number }).precession);
          before(dt);
          // preStep 之后复算牵引门（与 BeyPhysics.preStep 同式）
          beys.forEach((x, i) => {
            const T = BEY_TUNING;
            const grip = x.spec.tip.gearGrip;
            let g = x.breakout > 0 ? Math.max(grip, T.breakoutGrip) : grip;
            if (T.edgeGrip > 0 && x.intent.edgeW > 0) g = Math.max(g, T.edgeGrip * Math.min(1, x.intent.edgeW * 2));
            const open = g >= T.driveMinGrip && x.grounded && !x.dashing && x.spin > T.minStableSpin * 2;
            if (confirmed && open) st.gateOpenWhileConfirmed++;
            if (confirmed && open && x.intent.authority >= floor && floor > 0) st.gateOpenWhileRaised++;
            if (open && x.breakout <= 0 && x.intent.authority > 0) st.steeringReachesPhysics++;
            void p0[i];
          });
        };
        const h = createHash('sha256');
        const max = (sc.maxSeconds ?? 60) / PHYSICS_DT;
        let s = 0;
        for (; s < max && !b.result; s++) {
          pw.step();
          fingerprint(h, beys);
        }
        runs.push({ name: sc.name, group: sc.group, nn, mode, floor, hash: h.digest('hex'), steps: s, result: b.result ? `${b.result.winner}:${b.result.finish}` : 'timeout', ...st });
        pw.dispose();
      } finally {
        Math.random = orig;
      }
    }
  }
  writeFileSync(out, JSON.stringify({ runs }, null, 1));
}, 7_200_000);
