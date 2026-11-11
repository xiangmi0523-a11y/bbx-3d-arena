/// <reference types="node" />
/**
 * M4-B B2 根因探针（docs/engineering/m4-experiment-plan.md §4：没通过的臂要给出根因分析）。
 * 只读：不采用任何开关、不改游戏默认值；B2 的开关只在本文件运行期间打开，结束后恢复。输出行首 M4B-PROBE-。
 *
 *  Q1 数值分辨率：B2 开关下单台在 120 / 240 / 480 Hz（探针自己做物理子步：每个子步 preStep(dt/k) + world.step）下
 *     速度、倾角、轴的横向角速度、终结是否一致。120 Hz 那一组与 B2 单台套件同种子，用来核对探针本身（必须逐项相同）。
 *  Q2 接地运动学（同一批运行，逐子步）：轴心与地面接触点离转轴的距离 d、接触点切向滑移速度、接地占比、
 *     横向角速度相邻子步的相位差（物理章动 ≈ I_a ω_s / I_t′ · dt；每步 ≈ π 说明是逐步来回跳的数值抖动）。
 *  Q3 平底静稳定：不转 / 低速时放在场地中央、倾斜 θ0 静止释放，3 s 后是立回去还是倒下；与几何推算的倾倒角比较。
 *
 * 用法：npx vitest run --config vitest.diag.config.ts tests/diag/m4b-probe.diag.ts
 */
import { test } from 'vitest';
import { ARENA, floorHeight, floorNormal } from '../../src/game/arena/arenaSpec';
import { createArenaPhysics, TABLE_Y } from '../../src/game/arena/ArenaPhysics';
import { FINISH_TUNING } from '../../src/game/battle/BattleSystem';
import { BeyPhysics } from '../../src/game/beys/BeyPhysics';
import { beyMassProps } from '../../src/game/beys/massProps';
import { assembleBey } from '../../src/game/beys/parts/assemble';
import { SIGNATURE_LIST } from '../../src/game/beys/parts/catalog';
import { computeLaunch } from '../../src/game/launcher/launch';
import { FLAT_TIP, GYRO_EXPERIMENT } from '../../src/game/physics/gyro';
import { GRAVITY, loadRapier, PhysicsWorld, PHYSICS_DT } from '../../src/game/physics/PhysicsWorld';
import { seeded } from '../motion/motionSim';
import { findFloor, floorTouch, median, q, r2, r3 } from './m4.metrics';
import { out } from './m5b.shared';

type R = Awaited<ReturnType<typeof loadRapier>>;
const DT = PHYSICS_DT;
/** B2 的开关（m4b.diag.ts ARMS.B2，计划 §4.1） */
const B2 = { enabled: 1, pd: 0, tiltDrive: 1, flatTip: 1, explicitDrive: 0 };
const KEYS = ['lieren', 'senheng', 'ziyao', 'pandun'];
const RATES = [1, 2, 4];
const POWER = 0.8;

interface Manifold {
  numSolverContacts(): number;
  solverContactDist(i: number): number;
  solverContactPoint(i: number): { x: number; y: number; z: number } | null;
  numContacts(): number;
  contactImpulse(i: number): number;
}

function withB2<T>(fn: () => T): T {
  const old = { ...GYRO_EXPERIMENT };
  Object.assign(GYRO_EXPERIMENT, B2);
  try {
    return fn();
  } finally {
    Object.assign(GYRO_EXPERIMENT, old);
  }
}

function specOf(key: string) {
  const sg = SIGNATURE_LIST.find((s) => s.key === key)!;
  const spec = assembleBey(sg.loadout);
  const flat = spec.bit.visual.shape === 'gear-flat' || spec.bit.visual.shape === 'rubber';
  return { spec, flat, mp: beyMassProps(spec, { flatTip: flat ? FLAT_TIP : null }) };
}

/** 理论章动角速度（快陀螺近似）：支点固定 I_a ω / (I_t + m l²)，自由滑动 I_a ω / I_t */
function nutation(key: string) {
  const { spec, mp } = specOf(key);
  const l = mp.comY - spec.bit.contactRadius;
  return { pivotPerSpin: r3(mp.Ia / (mp.It + mp.mass * l * l)), freePerSpin: r3(mp.Ia / mp.It) };
}

interface BinAcc {
  frames: number;
  speed: number;
  tiltN: number;
  wPerp: number;
  r: number;
  subs: number;
  touch: number;
  d: number[];
  slip: number[];
  rim: number[];
  phase: number[];
  prec: number[];
}
const newBin = (): BinAcc => ({ frames: 0, speed: 0, tiltN: 0, wPerp: 0, r: 0, subs: 0, touch: 0, d: [], slip: [], rim: [], phase: [], prec: [] });

/** Q1 / Q2：B2 开关下单台转到停，k = 每个 1/120 s 的物理子步数 */
function soloProbe(R: R, key: string, seed: number, k: number, maxSeconds = 150) {
  const rnd0 = Math.random;
  Math.random = seeded(seed);
  try {
    const pw = new PhysicsWorld(R, { observeContacts: true });
    createArenaPhysics(pw);
    const floor = findFloor(R, pw.world);
    const { spec } = specOf(key);
    // 与 m4.runs.ts soloRun 相同的发射（同种子 → k = 1 时与 B2 单台套件逐项相同）
    const rnd = seeded(seed * 7 + 13);
    const params = computeLaunch(spec, 'player', { power: POWER, aim: (rnd() - 0.5) * 0.8, tilt: 0 });
    const bey = new BeyPhysics(pw, spec, { ...params, seed });
    const h = DT / k;
    pw.world.timestep = h;
    const tip = bey.colliders[0];
    const bins: BinAcc[] = Array.from({ length: 10 }, newBin);
    const series: number[][] = [];
    let end = 'limit';
    let endFrame = -1;
    let held = 0;
    let prevPx = 0;
    let prevPy = 0;
    let prevPz = 0;
    let havePrev = false;
    let prevAz = NaN;
    let lastFloorFrame = -1;
    let maxTiltLast = 0;
    const tiltHist: number[] = [];
    const frames = Math.round(maxSeconds / DT);
    let sTouch = 0;
    let sSubs = 0;
    let sD: number[] = [];
    let sSlip: number[] = [];
    let f = 0;
    for (; f < frames; f++) {
      const ratio0 = bey.spinRatio;
      const bi = Math.max(0, Math.min(9, Math.floor(ratio0 * 10)));
      const bin = bins[bi];
      for (let j = 0; j < k; j++) {
        bey.preStep(h);
        pw.world.step();
        // ── 逐子步：接地点、滑移、横向角速度相位 ──
        const u = bey.up();
        const w = bey.body.angvel();
        const ws = w.x * u.x + w.y * u.y + w.z * u.z;
        const px = w.x - u.x * ws;
        const py = w.y - u.y * ws;
        const pz = w.z - u.z * ws;
        const pl = Math.hypot(px, py, pz);
        if (havePrev && pl > 0.5) {
          const ql = Math.hypot(prevPx, prevPy, prevPz);
          if (ql > 0.5) bin.phase.push(Math.acos(Math.max(-1, Math.min(1, (px * prevPx + py * prevPy + pz * prevPz) / (pl * ql)))));
        }
        prevPx = px;
        prevPy = py;
        prevPz = pz;
        havePrev = true;
        let touching = false;
        let best: { x: number; y: number; z: number } | null = null;
        let bestD = Infinity;
        pw.world.contactPair(tip, floor, (m: Manifold) => {
          for (let i = 0, n = m.numSolverContacts(); i < n; i++) {
            const dd = m.solverContactDist(i);
            if (dd <= 1e-3) {
              touching = true;
              if (dd < bestD) {
                const sp = m.solverContactPoint(i);
                if (sp) {
                  bestD = dd;
                  best = { x: sp.x, y: sp.y, z: sp.z };
                }
              }
            }
          }
          for (let i = 0, n = m.numContacts(); i < n; i++) if (m.contactImpulse(i) > 0) touching = true;
        });
        bin.subs++;
        sSubs++;
        if (touching) {
          bin.touch++;
          sTouch++;
        }
        if (best) {
          const c = best as { x: number; y: number; z: number };
          const o = bey.body.translation();
          const ox = c.x - o.x;
          const oy = c.y - o.y;
          const oz = c.z - o.z;
          const along = ox * u.x + oy * u.y + oz * u.z;
          const d = Math.hypot(ox - u.x * along, oy - u.y * along, oz - u.z * along);
          const com = bey.comWorld();
          const rx = c.x - com.x;
          const ry = c.y - com.y;
          const rz = c.z - com.z;
          const v = bey.body.linvel();
          const vcx = v.x + (w.y * rz - w.z * ry);
          const vcy = v.y + (w.z * rx - w.x * rz);
          const vcz = v.z + (w.x * ry - w.y * rx);
          const rr = Math.hypot(c.x, c.z);
          const nn = rr <= ARENA.radius ? floorNormal(c.x, c.z) : [0, 1, 0];
          const vn = vcx * nn[0] + vcy * nn[1] + vcz * nn[2];
          const slip = Math.hypot(vcx - vn * nn[0], vcy - vn * nn[1], vcz - vn * nn[2]);
          bin.d.push(d);
          bin.slip.push(slip);
          bin.rim.push(Math.abs(ws) * d);
          sD.push(d);
          sSlip.push(slip);
        }
      }
      // ── 逐帧：速度、倾角、横向角速度、进动 ──
      const p = bey.body.translation();
      const v = bey.body.linvel();
      const u = bey.up();
      const w = bey.body.angvel();
      const ws = w.x * u.x + w.y * u.y + w.z * u.z;
      const r = Math.hypot(p.x, p.z);
      const n = r <= ARENA.radius ? floorNormal(p.x, p.z) : [0, 1, 0];
      const dot = Math.max(-1, Math.min(1, u.x * n[0] + u.y * n[1] + u.z * n[2]));
      const tiltN = Math.acos(dot);
      const speed = Math.hypot(v.x, v.z);
      const wPerp = Math.hypot(w.x - u.x * ws, w.y - u.y * ws, w.z - u.z * ws);
      bin.frames++;
      bin.speed += speed;
      bin.tiltN += tiltN;
      bin.wPerp += wPerp;
      bin.r += r;
      const tx = u.x - dot * n[0];
      const tz = u.z - dot * n[2];
      if (Math.hypot(tx, tz) > 0.02) {
        const az = Math.atan2(tz, tx);
        if (!Number.isNaN(prevAz)) bin.prec.push(Math.abs(Math.atan2(Math.sin(az - prevAz), Math.cos(az - prevAz))) / DT);
        prevAz = az;
      } else prevAz = NaN;
      tiltHist.push(tiltN);
      if (floorTouch(pw.world, bey, floor)) lastFloorFrame = f;
      if ((f + 1) % Math.round(0.5 / DT) === 0) {
        series.push([r2((f + 1) * DT), r3(bey.spinRatio), r2(r), r2(speed), r3(tiltN), r2(wPerp), r3(sSubs ? sTouch / sSubs : 0), r3(median(sD)), r2(median(sSlip))]);
        sTouch = 0;
        sSubs = 0;
        sD = [];
        sSlip = [];
      }
      const isOut = r > ARENA.radius + FINISH_TUNING.outMargin || p.y < TABLE_Y + 0.5;
      const toppled = bey.tilt > FINISH_TUNING.toppleTilt && bey.spin < FINISH_TUNING.toppleSpin;
      const stopped = bey.spin < FINISH_TUNING.stopSpin;
      if (isOut || toppled || stopped) {
        if (endFrame < 0) {
          endFrame = f;
          end = isOut ? 'out' : toppled ? 'topple' : 'stop';
        }
        held += DT;
        if (held > 0.5) break;
      } else {
        held = 0;
        endFrame = -1;
      }
    }
    const i0 = endFrame >= 0 ? endFrame : f - 1;
    for (let i = Math.max(0, i0 - Math.round(3 / DT)); i <= i0 && i < tiltHist.length; i++) maxTiltLast = Math.max(maxTiltLast, tiltHist[i]);
    pw.dispose();
    const binOut = bins
      .map((b, i) => ({ b, i }))
      .filter(({ b }) => b.frames > 0)
      .reverse()
      .map(({ b, i }) => ({
        ratio: `${(i / 10).toFixed(1)}–${((i + 1) / 10).toFixed(1)}`,
        seconds: r2(b.frames * DT),
        speed: r3(b.speed / b.frames),
        tiltN: r3(b.tiltN / b.frames),
        wPerp: r3(b.wPerp / b.frames),
        r: r2(b.r / b.frames),
        touchShare: r3(b.subs ? b.touch / b.subs : 0),
        dP50: r3(median(b.d)),
        slipP50: r3(median(b.slip)),
        rimP50: r3(median(b.rim)),
        slipOverRim: r3(median(b.slip) / Math.max(1e-6, median(b.rim))),
        phaseP50: r3(median(b.phase)),
        phaseP90: r3(q(b.phase, 0.9)),
        precP50: r3(median(b.prec)),
      }));
    return {
      key,
      seed,
      hz: Math.round(1 / h),
      end,
      endAt: r2((i0 + 1) * DT),
      maxTiltLast3: r3(maxTiltLast),
      floorBeforeEnd: lastFloorFrame >= 0 ? r2((i0 - lastFloorFrame) * DT) : null,
      bins: binOut,
      series,
    };
  } finally {
    Math.random = rnd0;
  }
}

/** Q3：静止、不转（或低速）放在场地中央，倾斜 θ0 释放 */
function standProbe(R: R, key: string, theta0: number, spin0: number) {
  const pw = new PhysicsWorld(R, { observeContacts: true });
  createArenaPhysics(pw);
  const { spec, flat, mp } = specOf(key);
  const lift = spec.bit.contactRadius * Math.sin(theta0) + 0.01;
  const bey = new BeyPhysics(pw, spec, {
    position: { x: 0, y: floorHeight(0) + lift, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    spin: spin0,
    tilt: theta0,
    tiltAxis: { x: 1, y: 0, z: 0 },
    seed: 1,
  });
  pw.beforeStep = (dt) => bey.preStep(dt);
  let maxTilt = 0;
  const rows: number[][] = [];
  for (let s = 0; s < Math.round(3 / DT); s++) {
    pw.step();
    maxTilt = Math.max(maxTilt, bey.tilt);
    if ((s + 1) % Math.round(0.5 / DT) === 0) rows.push([r2((s + 1) * DT), r3(bey.tilt), r2(bey.spin)]);
  }
  const finalTilt = bey.tilt;
  pw.dispose();
  // 几何推算：平底（圆角圆柱）绕边缘倒圆的圆心翻倒：tan θs = (R − b) / (comY − b)；球头 l = comY − r > 0 时直立不静稳
  const thetaStatic = flat
    ? Math.atan((spec.bit.contactRadius - FLAT_TIP.border) / (mp.comY - FLAT_TIP.border))
    : mp.comY > spec.bit.contactRadius
      ? 0
      : Math.PI / 2;
  return { key, flat, theta0, spin0, thetaStatic: r3(thetaStatic), finalTilt: r3(finalTilt), maxTilt: r3(maxTilt), fell: finalTilt > 0.6, upright: finalTilt < 0.05, rows };
}

test('M4-B 探针 Q3：平底静稳定（B2 接地几何）', async () => {
  const R = await loadRapier();
  withB2(() => {
    for (const key of KEYS)
      for (const theta0 of [0.15, 0.25, 0.35, 0.5])
        for (const spin0 of [0, 12]) out('M4B-PROBE-Q3', standProbe(R, key, theta0, spin0));
  });
  out('M4B-PROBE-G', { g: -GRAVITY, nutation: Object.fromEntries(KEYS.map((k) => [k, nutation(k)])) });
});

for (const key of KEYS)
  test(`M4-B 探针 Q1/Q2：${key} 120 / 240 / 480 Hz`, async () => {
    const R = await loadRapier();
    const si = SIGNATURE_LIST.findIndex((s) => s.key === key);
    // m4.runs.ts soloSuite 的种子：90000 + si·100 + pi·10 + i（力度 0.8 → pi = 1）
    const seeds = [0, 1].map((i) => 90000 + si * 100 + 10 + i);
    withB2(() => {
      for (const seed of seeds)
        for (const k of RATES) {
          const t0 = Date.now();
          const res = soloProbe(R, key, seed, k);
          out('M4B-PROBE-Q1', { ...res, ms: Date.now() - t0 });
        }
    });
  });
