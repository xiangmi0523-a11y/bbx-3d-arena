/**
 * 第三轮：低速接触与脱困逐步探针（120 Hz 每物理步记录）。
 * 按《0c30c09 低速接触与脱困机制专项诊断报告》第 0 节描述重写（原探针未入库），口径：
 *   - 接触 = 中心水平距离 < 两台刀刃半径和 + 0.05（几何近似，不读 Rapier 接触点）
 *   - 触发类型：BattleSystem.wobbleBreaks 增加 = death wobble；breakouts 增加但 wobbleBreaks 未增加 = 通用僵持
 *   - 每次触发：触发前快照、触发后 0.2 / 0.5 / 0.7 / 1.0 s 快照、脱离时间（触发时贴着）、再接触时间
 *   - 全部接触段（起止、时长、段内是否有触发、怎样结束）、死亡阶段（输家转速比例首次 < 0.2 到终局）接触占比
 *   - 额外（第三轮新增）：自然漂开后的再接触、低速静止段、最大半径、逐步最大速度变化 / 位移、终局倾斜
 * 同一场景在不同版本 / 配置跑完全相同的输入（tests/motion/scenarios.ts 的固定种子）。
 *   BP_VERSION=A BP_OUT=test-results/motion/bp-A.json DIAG_TUNE='{"stallBreak":1}' \
 *     npx vitest run --config vitest.diag.config.ts tests/diag/breakoutprobe.diag.ts
 * BP_GROUPS=AvD,DvA,... 选组（默认主矩阵 7 组 + LONG + WALL/AIM/PHASE）。
 * DIAG_TUNE 只在诊断进程里覆盖 BEY_TUNING（项目已有做法），不改代码。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { test } from 'vitest';
import { ARENA } from '../../src/game/arena/arenaSpec';
import { createArenaPhysics } from '../../src/game/arena/ArenaPhysics';
import { BattleSystem } from '../../src/game/battle/BattleSystem';
import { BEY_TUNING } from '../../src/game/beys/BeyPhysics';
import { assembleBey } from '../../src/game/beys/parts/assemble';
import { loadRapier, PhysicsWorld, PHYSICS_DT } from '../../src/game/physics/PhysicsWorld';
import { seeded } from '../motion/motionSim';
import { groups } from '../motion/scenarios';

if (process.env.DIAG_TUNE) Object.assign(BEY_TUNING, JSON.parse(process.env.DIAG_TUNE));

const r3 = (x: number) => +x.toFixed(3);
const AFTER = [0.2, 0.5, 0.7, 1.0];

interface Trig {
  t: number;
  kind: 'stall' | 'wobble';
  touching: boolean;
  d: number;
  gap: number;
  va: number;
  vb: number;
  spinA: number;
  spinB: number;
  ratioA: number;
  ratioB: number;
  tiltA: number;
  tiltB: number;
  contactBefore: number;
  after: Record<string, { d: number; touching: boolean } | null>;
  sepT: number | null;
  reT: number | null;
  /** 触发后 0.7 s 内双方水平速度的最大增量（相对触发瞬间） */
  dvAfter: number;
}

test('breakout probe', async () => {
  const R = await loadRapier();
  const version = process.env.BP_VERSION ?? 'now';
  const out = process.env.BP_OUT ?? `test-results/motion/bp-${version}.json`;
  const want = (process.env.BP_GROUPS ?? 'AvD,DvA,SvA,BvB,AvA,DFLT,POWER,LONG,WALL,AIM,PHASE').split(',');
  const res: Record<string, unknown[]> = {};
  for (const g of groups()) {
    if (!want.includes(g.key)) continue;
    res[g.key] = [];
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
      if (sc.phase) {
        (A as unknown as { precession: number }).precession = sc.phase[0];
        (B as unknown as { precession: number }).precession = sc.phase[1];
      }
      const bladeSum = A.spec.blade.radius + B.spec.blade.radius;
      const max = (sc.maxSeconds ?? 60) / PHYSICS_DT;
      const trigs: Trig[] = [];
      const segs: { t0: number; t1: number; trig: number; end: 'trigger' | 'natural' | 'end' }[] = [];
      let touching = false;
      let segStart = 0;
      let segTrig = 0;
      let prevBO = 0;
      let prevWB = 0;
      const ratioHist: [number, number, boolean][] = [];
      let maxR = 0;
      let maxStep = 0;
      let maxDv = 0;
      let maxDvFree = 0;
      let prevV = [
        { x: 0, z: 0 },
        { x: 0, z: 0 },
      ];
      let prevP = [A.body.translation(), B.body.translation()].map((p) => ({ x: p.x, z: p.z }));
      // 低速静止：双方水平速度 < 0.2 m/s 且转速 > 10；feelSim 口径僵持：< 0.8、距离 < 刀刃和 + 0.4、转速 > 10
      let still = 0;
      let stillLong = 0;
      let stillTot = 0;
      let stall = 0;
      let stallLong = 0;
      let stallTot = 0;
      let maxTiltA = 0;
      let maxTiltB = 0;
      let steps = 0;
      // 静止 / 僵持段明细（> 1 s）：起止、段内接触占比、平均中心距、段首段尾转速
      const stillEps: { t0: number; t1: number; touch: number; d: number; spin0: [number, number]; spin1: [number, number] }[] = [];
      let epStart = -1;
      let epTouch = 0;
      let epD = 0;
      let epN = 0;
      let epSpin0: [number, number] = [0, 0];
      const open: { tr: Trig; step: number; v0: [number, number]; sepDone: boolean; separated: boolean }[] = [];
      for (; steps < max && !b.result; steps++) {
        pw.step();
        const t = (steps + 1) * PHYSICS_DT;
        const pa = A.body.translation();
        const pb = B.body.translation();
        const va = A.body.linvel();
        const vb = B.body.linvel();
        const d = Math.hypot(pa.x - pb.x, pa.z - pb.z);
        const now = d < bladeSum + 0.05;
        const sa = Math.hypot(va.x, va.z);
        const sb = Math.hypot(vb.x, vb.z);
        maxTiltA = Math.max(maxTiltA, A.tilt);
        maxTiltB = Math.max(maxTiltB, B.tilt);
        // 逐步变化
        const cur = [va, vb];
        const pos = [pa, pb];
        for (let i = 0; i < 2; i++) {
          const dv = Math.hypot(cur[i].x - prevV[i].x, cur[i].z - prevV[i].z);
          const ds = Math.hypot(pos[i].x - prevP[i].x, pos[i].z - prevP[i].z);
          const r = Math.hypot(pos[i].x, pos[i].z);
          maxR = Math.max(maxR, r);
          if (steps > 0) {
            maxDv = Math.max(maxDv, dv);
            maxStep = Math.max(maxStep, ds);
            // 不接触、离墙较远（r < 半径 − 0.8）时的速度跳变：只可能来自内部驱动
            if (!now && d > bladeSum + 0.3 && r < ARENA.radius - 0.8) maxDvFree = Math.max(maxDvFree, dv);
          }
        }
        prevV = cur.map((v) => ({ x: v.x, z: v.z }));
        prevP = pos.map((p) => ({ x: p.x, z: p.z }));
        const stillNow = sa < 0.2 && sb < 0.2 && A.spin > 10 && B.spin > 10;
        still = stillNow ? still + PHYSICS_DT : 0;
        if (stillNow) stillTot += PHYSICS_DT;
        stillLong = Math.max(stillLong, still);
        if (stillNow) {
          if (epStart < 0) {
            epStart = t;
            epTouch = epD = epN = 0;
            epSpin0 = [r3(A.spin), r3(B.spin)];
          }
          epN++;
          epD += d;
          if (now) epTouch++;
        } else if (epStart >= 0) {
          if (t - epStart > 1) stillEps.push({ t0: r3(epStart), t1: r3(t), touch: r3(epTouch / epN), d: r3(epD / epN), spin0: epSpin0, spin1: [r3(A.spin), r3(B.spin)] });
          epStart = -1;
        }
        const stallNow = sa < 0.8 && sb < 0.8 && d < bladeSum + 0.4 && A.spin > 10 && B.spin > 10;
        stall = stallNow ? stall + PHYSICS_DT : 0;
        if (stallNow) stallTot += PHYSICS_DT;
        stallLong = Math.max(stallLong, stall);
        ratioHist.push([A.spinRatio, B.spinRatio, now]);

        // 接触段
        if (now && !touching) {
          segStart = t;
          segTrig = 0;
          for (const o of open) if (o.tr.reT === null && (o.separated || !o.tr.touching)) o.tr.reT = r3(t - o.tr.t);
        }
        // 触发检测
        if (b.breakouts > prevBO) {
          const kind: 'stall' | 'wobble' = b.wobbleBreaks > prevWB ? 'wobble' : 'stall';
          prevBO = b.breakouts;
          prevWB = b.wobbleBreaks;
          const tr: Trig = {
            t: r3(t),
            kind,
            touching: now,
            d: r3(d),
            gap: r3(d - bladeSum),
            va: r3(sa),
            vb: r3(sb),
            spinA: r3(A.spin),
            spinB: r3(B.spin),
            ratioA: r3(A.spinRatio),
            ratioB: r3(B.spinRatio),
            tiltA: r3(A.tilt),
            tiltB: r3(B.tilt),
            contactBefore: now ? r3(t - segStart) : 0,
            after: Object.fromEntries(AFTER.map((k) => [k, null])),
            sepT: null,
            reT: null,
            dvAfter: 0,
          };
          trigs.push(tr);
          if (now) segTrig++;
          open.push({ tr, step: steps, v0: [sa, sb], sepDone: !now, separated: !now });
        }
        // 已有触发的后续快照
        for (const o of open) {
          const el = (steps - o.step) * PHYSICS_DT;
          for (const k of AFTER) if (o.tr.after[k] === null && el >= k - 1e-9) o.tr.after[k] = { d: r3(d), touching: now };
          if (el <= 0.7 + 1e-9) o.tr.dvAfter = r3(Math.max(o.tr.dvAfter, sa - o.v0[0], sb - o.v0[1]));
          if (!o.sepDone && !now) {
            o.sepDone = true;
            o.separated = true;
            o.tr.sepT = r3(el);
          }
        }
        if (!now && touching) segs.push({ t0: r3(segStart), t1: r3(t), trig: segTrig, end: segTrig > 0 ? 'trigger' : 'natural' });
        touching = now;
      }
      if (touching) segs.push({ t0: r3(segStart), t1: r3(steps * PHYSICS_DT), trig: segTrig, end: 'end' });
      if (epStart >= 0 && steps * PHYSICS_DT - epStart > 1) stillEps.push({ t0: r3(epStart), t1: r3(steps * PHYSICS_DT), touch: r3(epTouch / epN), d: r3(epD / epN), spin0: epSpin0, spin1: [r3(A.spin), r3(B.spin)] });
      const res0 = b.result;
      const loser = res0 ? (res0.loser === 'player' ? 0 : 1) : -1;
      let death = NaN;
      let deathDur = NaN;
      if (loser >= 0) {
        const i0 = ratioHist.findIndex((h) => h[loser] < 0.2);
        if (i0 >= 0) {
          const tail = ratioHist.slice(i0);
          death = tail.filter((h) => h[2]).length / tail.length;
          deathDur = tail.length * PHYSICS_DT;
        }
      }
      const L = loser === 0 ? A : loser === 1 ? B : null;
      res[g.key].push({
        name: sc.name,
        result: res0 ? `${res0.winner}:${res0.finish}` : 'timeout',
        duration: r3(b.time),
        forced120: !!res0 && b.time > 120,
        breakouts: b.breakouts,
        wobbleBreaks: b.wobbleBreaks,
        stallForEnd: r3(b.stallFor),
        trigs,
        segs,
        death: r3(death),
        deathDur: r3(deathDur),
        loserTiltEnd: L ? r3(L.tilt) : null,
        loserSpinEnd: L ? r3(L.spin) : null,
        maxR: r3(maxR),
        maxStep: r3(maxStep),
        maxDv: r3(maxDv),
        maxDvFree: r3(maxDvFree),
        stillLong: r3(stillLong),
        stillTot: r3(stillTot),
        stillEps,
        bladeSum: r3(bladeSum),
        stallLong: r3(stallLong),
        stallTot: r3(stallTot),
        maxTilt: [r3(maxTiltA), r3(maxTiltB)],
        hits: b.hits,
        strong: b.impacts.filter((e) => e.tier !== 'light').length,
      });
      Math.random = orig;
      pw.dispose();
    }
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ version, tune: process.env.DIAG_TUNE ?? null, groups: res }));
}, 3_600_000);
