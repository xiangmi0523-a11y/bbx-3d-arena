/**
 * E2：牵引门槛反事实（driveMinGrip 0.2 → 0.05，只在诊断路径覆盖）。
 *   E2_MODE=A   不覆盖（Stage A 原始门槛）
 *   E2_MODE=B   只对针尖对针尖场次覆盖为 0.05（每场结束后无条件恢复）；其他 156 场不覆盖
 *   E2_MODE=G   信息性：对全部 180 场覆盖（只用于说明门槛是全局按陀尖生效，不作为实验组）
 *   E2_OUT=目录（默认 test-results/e1e2/e2-<MODE>）
 * 输出 runs.json（逐场指标、逐 10 s 窗口指标与分类、逐步 hash）与针尖对针尖的逐步轨迹 track/*.csv.gz。
 * 不加任何推力、偏置或控制器；gearGrip、全局参数、碗面、摩擦、滚动阻力、碰撞、AI 意图都不变。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { test } from 'vitest';
import { BEY_TUNING } from '../../src/game/beys/BeyPhysics';
import { loadRapier, PHYSICS_DT } from '../../src/game/physics/PhysicsWorld';
import { seeded } from '../motion/motionSim';
import { classifyWindow, instrument, isNN, LowSpeed, newTrack, windowMetrics, withDriveMinGrip } from './e1e2.shared';
import { fingerprint, scenariosV2, setup } from './stallprobe2.shared';

const r4 = (x: number) => (Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : x);
const rObj = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, r4(v)]));

test('E2 traction gate', async () => {
  const R = await loadRapier();
  const mode = (process.env.E2_MODE ?? 'A') as 'A' | 'B' | 'G';
  const GRIP = 0.05;
  const outDir = process.env.E2_OUT ?? `test-results/e1e2/e2-${mode}`;
  mkdirSync(join(outDir, 'track'), { recursive: true });
  const runs: unknown[] = [];
  for (const sc of scenariosV2()) {
    const orig = Math.random;
    let nn = false;
    Math.random = seeded(sc.seed);
    try {
      const probe = setup(R, sc);
      nn = isNN([probe.A, probe.B]);
      probe.pw.dispose();
    } finally {
      Math.random = orig;
    }
    const grip = mode === 'G' || (mode === 'B' && nn) ? GRIP : null;
    Math.random = seeded(sc.seed);
    try {
      withDriveMinGrip(grip, () => {
        const minGripInRun = BEY_TUNING.driveMinGrip;
        const { pw, b, A, B } = setup(R, sc);
        const beys = [A, B] as [typeof A, typeof B];
        const ins = instrument(R, pw, b, beys, false);
        const h = createHash('sha256');
        const max = (sc.maxSeconds ?? 60) / PHYSICS_DT;
        const tr = newTrack(max + 1);
        const ls = new LowSpeed();
        const eligible = [0, 0];
        const tracSteps = [0, 0];
        let maxAcc = 0;
        let maxR = 0;
        let maxSpeed = 0;
        let wallSteps = 0;
        let geomSteps = 0;
        const segs: [number, number][] = [];
        let segStart = -1;
        const spinAt: Record<string, number[]> = {};
        let s = 0;
        for (; s < max && !b.result; s++) {
          pw.step();
          fingerprint(h, beys);
          const low = ls.step(b, A, B);
          const geo = b.contactClass.geometric;
          tr.geo[s] = geo ? 1 : 0;
          tr.low[s] = low ? 1 : 0;
          if (geo) geomSteps++;
          if (geo && segStart < 0) segStart = s;
          if (!geo && segStart >= 0) {
            segs.push([segStart, s]);
            segStart = -1;
          }
          beys.forEach((x, i) => {
            const p = x.body.translation();
            const v = x.body.linvel();
            const L = ins.led[i];
            tr.px[i][s] = p.x;
            tr.pz[i][s] = p.z;
            tr.speed[i][s] = Math.hypot(v.x, v.z);
            tr.spin[i][s] = x.spin;
            tr.trac[i][s] = L.tracOn ? 1 : 0;
            if (L.tracOn) tracSteps[i]++;
            if (x.grounded && x.spin > BEY_TUNING.minStableSpin * 2 && !x.dashing) eligible[i]++;
            const rr = Math.hypot(p.x, p.z);
            maxR = Math.max(maxR, rr);
            maxSpeed = Math.max(maxSpeed, tr.speed[i][s]);
            if (rr > 4.75) wallSteps++;
            // 非撞击水平加速度（m/s²）：步内 Δv 去掉 resolveSmash 冲量
            const ax = (L.m * (L.v3.x - L.v0.x) - L.smash.x) / L.m / PHYSICS_DT;
            const az = (L.m * (L.v3.z - L.v0.z) - L.smash.z) / L.m / PHYSICS_DT;
            maxAcc = Math.max(maxAcc, Math.hypot(ax, az));
          });
          for (const T of [10, 30, 60, 90]) if (s + 1 === Math.round(T / PHYSICS_DT)) spinAt[`t${T}`] = [A.spinRatio, B.spinRatio].map(r4);
        }
        if (segStart >= 0) segs.push([segStart, s]);
        tr.n = s;
        // 低速段
        let low = 0;
        let lowTotal = 0;
        let lowLongest = 0;
        let lowLongestStart = 0;
        for (let k = 0; k < s; k++) {
          low = tr.low[k] ? low + 1 : 0;
          if (tr.low[k]) lowTotal++;
          if (low > lowLongest) {
            lowLongest = low;
            lowLongestStart = k - low + 1;
          }
        }
        // 重新接触：相邻几何接触段之间的间隔（s）
        const gaps = segs.slice(1).map((g, k) => r4((g[0] - segs[k][1]) * PHYSICS_DT));
        // 逐 10 s 窗口（从 10 s 开始，连续不重叠，只取完整窗口）
        const W = Math.round(10 / PHYSICS_DT);
        const windows: unknown[] = [];
        for (let i0 = W; i0 + W <= s; i0 += W) {
          const per = [0, 1].map((i) => {
            const m = windowMetrics(tr, i, i0, i0 + W);
            return { ...rObj(m), cls: classifyWindow(m) };
          });
          let wGeo = 0;
          for (let k = i0; k < i0 + W; k++) wGeo += tr.geo[k];
          windows.push({ t0: r4(i0 * PHYSICS_DT), geoSteps: wGeo, spin: [0, 1].map((i) => r4(tr.spin[i][i0])), per });
        }
        // 参照窗口：2–12 s（多数非针尖对针尖对局在 20 s 内结束，从 10 s 起的窗口太少，用这个窗口作“自然运动”参照）
        const e0 = Math.round(2 / PHYSICS_DT);
        const early =
          e0 + W <= s
            ? {
                t0: 2,
                geoSteps: (() => {
                  let g = 0;
                  for (let k = e0; k < e0 + W; k++) g += tr.geo[k];
                  return g;
                })(),
                per: [0, 1].map((i) => {
                  const m = windowMetrics(tr, i, e0, e0 + W);
                  return { ...rObj(m), cls: classifyWindow(m) };
                }),
              }
            : null;
        const res = b.result;
        runs.push({
          name: sc.name,
          group: sc.group,
          seed: sc.seed,
          tips: beys.map((x) => x.spec.tip.id),
          nn,
          overridden: grip !== null,
          driveMinGrip: minGripInRun,
          hash: h.digest('hex'),
          steps: s,
          result: res ? `${res.winner}:${res.finish}` : 'timeout',
          duration: r4(b.time),
          tracSteps,
          tracShare: tracSteps.map((x) => r4(x / s)),
          tracShareEligible: tracSteps.map((x, i) => r4(eligible[i] ? x / eligible[i] : 0)),
          lowTotal: r4(lowTotal * PHYSICS_DT),
          lowShare: r4(lowTotal / s),
          lowLongest: r4(lowLongest * PHYSICS_DT),
          lowLongestStart: r4(lowLongestStart * PHYSICS_DT),
          geomSteps,
          contactSegs: segs.length,
          firstContact: segs.length ? r4(segs[0][0] * PHYSICS_DT) : null,
          gaps,
          hits: b.hits,
          wobbleBreaks: b.wobbleBreaks,
          breakouts: b.breakouts,
          maxSpeed: r4(maxSpeed),
          maxR: r4(maxR),
          wallSteps,
          maxAccNoSmash: r4(maxAcc),
          spinAt,
          spinLossPerS: [A, B].map((x) => r4((x.launchSpin - x.spin) / Math.max(1e-9, b.time))),
          windows,
          early,
        });
        if (nn) {
          const rows = ['t,aX,aZ,bX,bZ,aSpeed,bSpeed,aSpin,bSpin,geometric,low,aTrac,bTrac'];
          for (let k = 0; k < s; k++) rows.push([r4((k + 1) * PHYSICS_DT), r4(tr.px[0][k]), r4(tr.pz[0][k]), r4(tr.px[1][k]), r4(tr.pz[1][k]), r4(tr.speed[0][k]), r4(tr.speed[1][k]), r4(tr.spin[0][k]), r4(tr.spin[1][k]), tr.geo[k], tr.low[k], tr.trac[0][k], tr.trac[1][k]].join(','));
          writeFileSync(join(outDir, 'track', `${sc.name.replace(/[^\w.#-]+/g, '_').replace('#', '_')}.csv.gz`), gzipSync(rows.join('\n')));
        }
        pw.dispose();
      });
    } finally {
      Math.random = orig;
    }
    if (BEY_TUNING.driveMinGrip !== 0.2) throw new Error(`driveMinGrip 未恢复：${BEY_TUNING.driveMinGrip}`);
  }
  writeFileSync(join(outDir, 'runs.json'), JSON.stringify({ mode, grip: GRIP, runs }));
}, 7_200_000);
