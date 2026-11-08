/**
 * Stage B：R1c 受控恢复 A/B 固定种子对照（与探针 V2 / Stage A 相同的 180 场矩阵与种子）。
 *   A：R1C='{"enabled":0}'（Stage A 基线物理）   B：默认（R1C_TUNING.enabled = 1）
 *   R1C_OUT=目录（默认 test-results/r1c/<R1C_VERSION>）  SP_GROUPS=...  DIAG_TUNE=...
 * 输出 runs.json（逐场指标 + 每次恢复记录）与针尖对针尖场次的逐步轨迹 track/*.csv.gz。
 * 净位移全部由真实坐标在明确时间窗口内计算（不由速度推算）。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { test } from 'vitest';
import { R1C_TUNING } from '../../src/game/battle/stallRecovery';
import { BEY_TUNING } from '../../src/game/beys/BeyPhysics';
import { loadRapier, PHYSICS_DT } from '../../src/game/physics/PhysicsWorld';
import { seeded } from '../motion/motionSim';
import { fingerprint, scenariosV2, setup } from './stallprobe2.shared';

if (process.env.DIAG_TUNE) Object.assign(BEY_TUNING, JSON.parse(process.env.DIAG_TUNE));
if (process.env.R1C) Object.assign(R1C_TUNING, JSON.parse(process.env.R1C));

const r4 = (x: number) => (Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : x);
const SPIN_MIN = 10;

test('R1c A/B', async () => {
  const R = await loadRapier();
  const version = process.env.R1C_VERSION ?? (R1C_TUNING.enabled > 0 ? 'B' : 'A');
  const outDir = process.env.R1C_OUT ?? `test-results/r1c/${version}`;
  mkdirSync(join(outDir, 'track'), { recursive: true });
  const want = process.env.SP_GROUPS?.split(',') ?? null;
  const runs: unknown[] = [];
  for (const sc of scenariosV2()) {
    if (want && !want.includes(sc.group)) continue;
    const orig = Math.random;
    Math.random = seeded(sc.seed);
    try {
      const { pw, b, A, B } = setup(R, sc);
      const beys = [A, B];
      const nn = beys.every((x) => x.spec.tip.gearGrip < BEY_TUNING.driveMinGrip);
      const h = createHash('sha256');
      const max = (sc.maxSeconds ?? 60) / PHYSICS_DT;
      const N = max + 1;
      const px = [new Float64Array(N), new Float64Array(N)];
      const pz = [new Float64Array(N), new Float64Array(N)];
      const geo = new Uint8Array(N);
      const spd = [new Float32Array(N), new Float32Array(N)];
      const rr = [new Float32Array(N), new Float32Array(N)];
      const track: (number | string)[][] = [];
      // 低速段（与 V2 WATCH(0.4) 同口径：几何接触或冲量响应后 6 步内算接触）
      let miss = 99;
      let low = 0;
      let lowLongest = 0;
      let lowLongestStart = 0;
      let lowLongestRatio = [0, 0];
      let lowStartRatio = [0, 0];
      let lowTotal = 0;
      const lowReject: Record<string, number> = {};
      const lowAt = new Float32Array(N);
      let geomSteps = 0;
      let contactSegs = 0;
      let prevGeo = false;
      let wallSteps = 0;
      let maxR = 0;
      let maxSpeed = 0;
      let s = 0;
      for (; s < max && !b.result; s++) {
        pw.step();
        fingerprint(h, beys);
        const k = b.contactClass;
        const touch = k.geometric || k.impulseResponse;
        miss = touch ? 0 : miss + 1;
        geo[s] = k.geometric ? 1 : 0;
        if (k.geometric) geomSteps++;
        if (k.geometric && !prevGeo) contactSegs++;
        prevGeo = k.geometric;
        beys.forEach((x, i) => {
          const p = x.body.translation();
          const v = x.body.linvel();
          px[i][s] = p.x;
          pz[i][s] = p.z;
          spd[i][s] = Math.hypot(v.x, v.z);
          rr[i][s] = Math.hypot(p.x, p.z);
          maxSpeed = Math.max(maxSpeed, spd[i][s]);
          maxR = Math.max(maxR, rr[i][s]);
        });
        if (rr[0][s] > 4.75 || rr[1][s] > 4.75) wallSteps++;
        const isLow = miss > 6 && spd[0][s] < 0.4 && spd[1][s] < 0.4 && A.spin > SPIN_MIN && B.spin > SPIN_MIN;
        if (isLow && low === 0) lowStartRatio = [A.spinRatio, B.spinRatio];
        low = isLow ? low + PHYSICS_DT : 0;
        if (isLow) {
          lowTotal += PHYSICS_DT;
          const why = b.recovery.state === 'idle' || b.recovery.state === 'dwell' ? (b.recovery.reject ?? b.recovery.state) : b.recovery.state;
          lowReject[why] = (lowReject[why] ?? 0) + PHYSICS_DT;
        }
        lowAt[s] = low;
        if (low > lowLongest) {
          lowLongest = low;
          lowLongestStart = (s + 1) * PHYSICS_DT - low;
          lowLongestRatio = lowStartRatio;
        }
        if (nn) {
          const pu = b.recovery.push;
          track.push([r4((s + 1) * PHYSICS_DT), r4(px[0][s]), r4(pz[0][s]), r4(px[1][s]), r4(pz[1][s]), r4(spd[0][s]), r4(spd[1][s]), r4(A.spin), r4(B.spin), k.geometric ? 1 : 0, k.predictive ? 1 : 0, b.recovery.state, pu[0].on ? 1 : 0, pu[1].on ? 1 : 0, r4(pu[0].dx), r4(pu[0].dz), r4(pu[1].dx), r4(pu[1].dz), r4(pu[0].tx), r4(pu[0].tz), r4(pu[1].tx), r4(pu[1].tz)]);
        }
      }
      const steps = s;
      const idx = (t: number) => Math.min(steps - 1, Math.max(0, Math.round(t / PHYSICS_DT) - 1));
      const net = (i: number, t0: number, t1: number) => Math.hypot(px[i][idx(t1)] - px[i][idx(t0)], pz[i][idx(t1)] - pz[i][idx(t0)]);
      const path = (i: number, t0: number, t1: number) => {
        let p = 0;
        for (let j = idx(t0) + 1; j <= idx(t1); j++) p += Math.hypot(px[i][j] - px[i][j - 1], pz[i][j] - pz[i][j - 1]);
        return p;
      };
      const tEnd = steps * PHYSICS_DT;
      const acts = b.recovery.log.map((a) => {
        const i0 = idx(a.t0);
        let reT: number | null = null;
        for (let j = i0; j < steps && (j - i0) * PHYSICS_DT <= 3; j++) if (geo[j]) {
          reT = (j - i0) * PHYSICS_DT;
          break;
        }
        let mr = 0;
        let ms = 0;
        for (let j = i0; j < steps && (j - i0) * PHYSICS_DT <= 3; j++) {
          mr = Math.max(mr, rr[0][j], rr[1][j]);
          ms = Math.max(ms, spd[0][j], spd[1][j]);
        }
        const w = (t0: number, t1: number) => (t1 <= tEnd && t0 >= 0 ? [0, 1].map((i) => r4(net(i, t0, t1))) : null);
        const wp = (t0: number, t1: number) => (t1 <= tEnd && t0 >= 0 ? [0, 1].map((i) => r4(path(i, t0, t1))) : null);
        return {
          ...Object.fromEntries(Object.entries(a).map(([k2, v]) => [k2, Array.isArray(v) ? v.map(r4) : typeof v === 'number' ? r4(v) : v])),
          lowBefore: r4(lowAt[Math.max(0, i0 - 1)]),
          netPre3: w(a.t0 - 3, a.t0),
          pathPre3: wp(a.t0 - 3, a.t0),
          netPost1: w(a.t0, a.t0 + 1),
          netPost3: w(a.t0, a.t0 + 3),
          pathPost3: wp(a.t0, a.t0 + 3),
          reContactT: reT === null ? null : r4(reT),
          maxR3: r4(mr),
          maxSpeed3: r4(ms),
        };
      });
      const res = b.result;
      runs.push({
        name: sc.name,
        group: sc.group,
        seed: sc.seed,
        tips: beys.map((x) => x.spec.tip.id),
        nn,
        hash: h.digest('hex'),
        steps,
        result: res ? `${res.winner}:${res.finish}` : 'timeout',
        duration: r4(b.time),
        lowLongest: r4(lowLongest),
        lowLongestStart: r4(lowLongestStart),
        lowLongestSpinRatio: lowLongestRatio.map(r4),
        lowTotal: r4(lowTotal),
        lowByR1cState: Object.fromEntries(Object.entries(lowReject).map(([k, v]) => [k, r4(v)])),
        geomSteps,
        contactSegs,
        hits: b.hits,
        wallSteps,
        maxR: r4(maxR),
        maxSpeed: r4(maxSpeed),
        wobbleBreaks: b.wobbleBreaks,
        breakouts: b.breakouts,
        acts,
      });
      if (nn) {
        const cols = ['t', 'aX', 'aZ', 'bX', 'bZ', 'aSpeed', 'bSpeed', 'aSpin', 'bSpin', 'geometric', 'predictive', 'r1c', 'aPush', 'bPush', 'aDx', 'aDz', 'bDx', 'bDz', 'aTx', 'aTz', 'bTx', 'bTz'];
        writeFileSync(join(outDir, 'track', `${sc.name.replace(/[^\w.#-]+/g, '_').replace('#', '_')}.csv.gz`), gzipSync([cols.join(','), ...track.map((r) => r.join(','))].join('\n')));
      }
      pw.dispose();
    } finally {
      Math.random = orig;
    }
  }
  writeFileSync(join(outDir, 'runs.json'), JSON.stringify({ version, r1c: { ...R1C_TUNING }, tune: process.env.DIAG_TUNE ?? null, runs }));
}, 7_200_000);
