/**
 * 脱困机制专项探针（临时诊断，不改业务代码）。
 *
 * 逐场记录两种脱困的每次触发：触发前状态、触发后 0.2/0.5/0.7/1.0 秒快照、
 * 脱离与再接触时间；并记录全部接触段（起止、时长、段内触发情况）与死亡阶段接触占比。
 *
 * 对照组用环境变量做运行时调参（与 contactmix.diag.ts 的 DIAG_TUNE 机制相同，
 * 只在诊断进程里改 BEY_TUNING，不改源码）：
 *   DIAG_TUNE='{"wobbleBreak":0}'                    关闭 death wobble
 *   DIAG_TUNE='{"wobbleBreak":0,"stallTime":1e9}'     两种脱困都关闭
 *
 *   BP_VERSION=0c30c09 BP_OUT=test-results/motion/bp-0c30c09.json \
 *     npx vitest run --config vitest.diag.config.ts tests/diag/breakoutprobe.diag.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { test } from 'vitest';
import { createArenaPhysics } from '../../src/game/arena/ArenaPhysics';
import { BattleSystem } from '../../src/game/battle/BattleSystem';
import { BEY_TUNING } from '../../src/game/beys/BeyPhysics';
import { assembleBey } from '../../src/game/beys/parts/assemble';
import { loadRapier, PhysicsWorld, PHYSICS_DT } from '../../src/game/physics/PhysicsWorld';
import { groups } from '../motion/scenarios';

function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

interface Snap {
  t: number;
  d: number;
  touching: boolean;
  nearStall: boolean;
  aSpin: number;
  bSpin: number;
  aRatio: number;
  bRatio: number;
  aTilt: number;
  bTilt: number;
  aTiltEx: number;
  bTiltEx: number;
  aSpeed: number;
  bSpeed: number;
  aBO: number;
  bBO: number;
  aState: string;
  bState: string;
  stallFor: number;
  wobbleFor: number;
  wobbleCool: number;
}

test('breakout probe', async () => {
  const tuneRaw = process.env.DIAG_TUNE;
  const tune = tuneRaw ? (JSON.parse(tuneRaw) as Record<string, number>) : null;
  if (tune) Object.assign(BEY_TUNING as unknown as Record<string, number>, tune);
  const version = process.env.BP_VERSION ?? 'now';
  const out = process.env.BP_OUT ?? `test-results/motion/bp-${version}.json`;
  const only = process.env.BP_GROUPS?.split(',') ?? ['AvD', 'DvA', 'SvA', 'BvB', 'AvA', 'DFLT', 'POWER'];
  const R = await loadRapier();
  const matches: Record<string, unknown>[] = [];
  let totalStall = 0;
  let totalWobble = 0;
  let matchesWithStall = 0;
  let matchesWithWobble = 0;

  for (const g of groups()) {
    if (!only.includes(g.key)) continue;
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
      const bladeSum = A.spec.blade.radius + B.spec.blade.radius;
      const outerSum = A.spec.outerRadius + B.spec.outerRadius;
      const maxSteps = Math.round((sc.maxSeconds ?? 60) / PHYSICS_DT);

      const triggers: Record<string, unknown>[] = [];
      const episodes: Record<string, unknown>[] = [];
      let prevBO = 0;
      let prevWB = 0;
      let prevSnap: Snap | null = null;
      let contactFor = 0;
      let epStart = -1;
      let epMaxTilt = 0;
      let epMinRatio = 1;
      let epTriggers = 0;
      let deathStart = -1;
      let deathSteps = 0;
      let deathTouch = 0;
      let pending: { trigIdx: number; at: number; label: string; done: boolean }[] = [];
      // 每个触发的脱离/再接触追踪（只跟踪最近一次触发）
      let trackTrig: { idx: number; t: number; sepAt: number | null; reAt: number | null } | null = null;

      const snap = (t: number): Snap => {
        const pa = A.body.translation();
        const pb = B.body.translation();
        const va = A.body.linvel();
        const vb = B.body.linvel();
        const d = Math.hypot(pa.x - pb.x, pa.z - pb.z);
        return {
          t: r3(t),
          d: r3(d),
          touching: d < bladeSum + 0.05,
          nearStall: d < outerSum + 0.4,
          aSpin: r2(A.spin),
          bSpin: r2(B.spin),
          aRatio: r3(A.spinRatio),
          bRatio: r3(B.spinRatio),
          aTilt: r3(A.tilt),
          bTilt: r3(B.tilt),
          aTiltEx: r3(A.tilt - A.spec.tip.drift),
          bTiltEx: r3(B.tilt - B.spec.tip.drift),
          aSpeed: r2(Math.hypot(va.x, va.z)),
          bSpeed: r2(Math.hypot(vb.x, vb.z)),
          aBO: r3(Math.max(0, A.breakout)),
          bBO: r3(Math.max(0, B.breakout)),
          aState: A.intentState,
          bState: B.intentState,
          stallFor: r3((b as unknown as { stallFor: number }).stallFor ?? 0),
          wobbleFor: r3(((b as unknown as { wobbleFor: number }).wobbleFor ?? 0) as number),
          wobbleCool: r3(((b as unknown as { wobbleCool: number }).wobbleCool ?? 0) as number),
        };
      };

      let steps = 0;
      for (let i = 0; i < maxSteps && !b.result; i++) {
        const t = i * PHYSICS_DT;
        steps = i + 1;
        const pre = snap(t);
        pw.step();
        const cur = snap(t + PHYSICS_DT);
        // 接触段跟踪（以步后状态为准）
        if (cur.touching) {
          contactFor += PHYSICS_DT;
          if (epStart < 0) {
            epStart = t;
            epMaxTilt = 0;
            epMinRatio = 1;
            epTriggers = 0;
          }
          epMaxTilt = Math.max(epMaxTilt, cur.aTilt, cur.bTilt);
          epMinRatio = Math.min(epMinRatio, cur.aRatio, cur.bRatio);
        } else {
          if (epStart >= 0) {
            episodes.push({ t0: r2(epStart), t1: r2(t), dur: r2(t - epStart), maxTilt: r2(epMaxTilt), minRatio: r3(epMinRatio), triggers: epTriggers });
            epStart = -1;
          }
          contactFor = 0;
        }
        // 死亡阶段：输家转速比首次 < 0.2（按当前 spinRatio 最低方近似，终局时再按胜负方校准为接触占比）
        const loserRatio = Math.min(cur.aRatio, cur.bRatio);
        if (deathStart < 0 && loserRatio < 0.2) deathStart = t;
        if (deathStart >= 0) {
          deathSteps++;
          if (cur.touching) deathTouch++;
        }
        // 触发检测
        const bo = (b as unknown as { breakouts: number }).breakouts;
        const wb = ((b as unknown as { wobbleBreaks: number }).wobbleBreaks ?? 0) as number;
        if (bo > prevBO) {
          const isWob = wb > prevWB;
          const low = cur.aRatio <= cur.bRatio ? 'a' : 'b';
          const trig = {
            idx: triggers.length,
            t: r3(t + PHYSICS_DT),
            type: isWob ? 'wobble' : 'stall',
            pre: pre,
            contactDur: r2(contactFor),
            low,
            cond: isWob
              ? {
                  touching: pre.touching,
                  lowSpin: low === 'a' ? pre.aRatio : pre.bRatio,
                  lowTiltEx: low === 'a' ? pre.aTiltEx : pre.bTiltEx,
                  highSpin: low === 'a' ? pre.bRatio : pre.aRatio,
                  highCanDrive: (low === 'a' ? pre.bSpin : pre.aSpin) > 14,
                }
              : {
                  aSpeedLt08: pre.aSpeed < 0.8,
                  bSpeedLt08: pre.bSpeed < 0.8,
                  nearStall: pre.nearStall,
                  aSpinGt10: pre.aSpin > 10,
                  bSpinGt10: pre.bSpin > 10,
                },
            post: {} as Record<string, Snap | null>,
            sepAfter: null as number | null,
            reAfter: null as number | null,
          };
          triggers.push(trig);
          if (isWob) totalWobble++;
          else totalStall++;
          if (epStart >= 0) epTriggers++;
          for (const [label, dt] of [['p02', 0.2], ['p05', 0.5], ['p07', 0.7], ['p10', 1.0]] as const) {
            pending.push({ trigIdx: triggers.length - 1, at: t + PHYSICS_DT + dt, label, done: false });
          }
          trackTrig = { idx: triggers.length - 1, t: t + PHYSICS_DT, sepAt: null, reAt: null };
        }
        prevBO = bo;
        prevWB = wb;
        prevSnap = cur;
        // 待快照
        for (const p of pending) {
          if (!p.done && t + PHYSICS_DT >= p.at) {
            (triggers[p.trigIdx].post as Record<string, Snap | null>)[p.label] = snap(t + PHYSICS_DT);
            p.done = true;
          }
        }
        // 脱离 / 再接触追踪
        if (trackTrig) {
          const tr = triggers[trackTrig.idx] as unknown as { sepAfter: number | null; reAfter: number | null };
          if (trackTrig.sepAt === null) {
            if (!cur.touching) {
              trackTrig.sepAt = t + PHYSICS_DT;
              tr.sepAfter = r2(trackTrig.sepAt - trackTrig.t);
            }
          } else if (trackTrig.reAt === null && cur.touching) {
            trackTrig.reAt = t + PHYSICS_DT;
            tr.reAfter = r2(trackTrig.reAt - trackTrig.t);
          }
        }
      }
      // 收尾：未完成的接触段、未到期的快照记为缺失
      if (epStart >= 0) {
        episodes.push({ t0: r2(epStart), t1: r2(steps * PHYSICS_DT), dur: r2(steps * PHYSICS_DT - epStart), maxTilt: r2(epMaxTilt), minRatio: r3(epMinRatio), triggers: epTriggers, open: true });
      }
      for (const p of pending) {
        if (!p.done) (triggers[p.trigIdx].post as Record<string, Snap | null>)[p.label] = null;
      }
      const nStall = triggers.filter((x) => x.type === 'stall').length;
      const nWob = triggers.filter((x) => x.type === 'wobble').length;
      if (nStall > 0) matchesWithStall++;
      if (nWob > 0) matchesWithWobble++;
      matches.push({
        name: sc.name,
        group: g.key,
        seed: sc.seed,
        player: `${sc.player.blade}/${sc.player.tip}`,
        rival: `${sc.rival.blade}/${sc.rival.tip}`,
        result: b.result ? `${b.result.winner}:${b.result.finish}` : 'timeout',
        duration: r2(steps * PHYSICS_DT),
        nStall,
        nWobble: nWob,
        triggers,
        episodes,
        death: deathStart >= 0 ? { start: r2(deathStart), dur: r2(steps * PHYSICS_DT - deathStart), contactFrac: deathSteps ? r3(deathTouch / deathSteps) : 0 } : null,
        endSpin: [r2(A.spin), r2(B.spin)],
        endTilt: [r2(A.tilt), r2(B.tilt)],
      });
      Math.random = orig;
      pw.dispose();
    }
  }
  const summary = {
    version,
    tune,
    runs: matches.length,
    totalStall,
    totalWobble,
    matchesWithStall,
    matchesWithWobble,
    timeouts: matches.filter((m) => m.result === 'timeout').length,
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ summary, matches }, null, 1));
  console.log('[breakoutprobe]', JSON.stringify(summary));
}, 1200000);
