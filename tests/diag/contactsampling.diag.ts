/**
 * Stage A 接触观测层：全场景矩阵（与探针 V2 相同的 180 场、相同种子）上的观测变化统计。
 * 物理是否变化不在这里判断（见 stallprobe2-plain.diag.ts + scripts/stallprobe2-verify.mjs 的跨树 hash 对照）。
 *
 * 每步同时计算：
 *  - 新版正式采样（BattleSystem.contactEvidence / contactClass）
 *  - 旧版规则复算：XZ 中心距 > outerSum + 0.12 不查询；touching = 法向冲量 > 0
 *  - 门槛正确性：新版跳过的步，无条件查询必须没有任何接触流形
 * 并把旧版规则的 touching 喂给一个独立的 ContactFeedback 实例，与正式实例对比接触段统计（只是反馈层）。
 *   CS_OUT=文件（默认 test-results/contactsampling/obs.json）  SP_GROUPS=...  DIAG_TUNE=...
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { test } from 'vitest';
import { ContactFeedback, type ContactSample } from '../../src/game/battle/contactFeedback';
import { emptyEvidence, queryContact } from '../../src/game/battle/contactSampling';
import { BEY_TUNING } from '../../src/game/beys/BeyPhysics';
import { loadRapier, PHYSICS_DT } from '../../src/game/physics/PhysicsWorld';
import { seeded } from '../motion/motionSim';
import { scenariosV2, setup } from './stallprobe2.shared';

if (process.env.DIAG_TUNE) Object.assign(BEY_TUNING, JSON.parse(process.env.DIAG_TUNE));

test('contact sampling observation (Stage A)', async () => {
  const R = await loadRapier();
  const out = process.env.CS_OUT ?? 'test-results/contactsampling/obs.json';
  mkdirSync(dirname(out), { recursive: true });
  const want = process.env.SP_GROUPS?.split(',') ?? null;
  const runs: Record<string, unknown>[] = [];
  const t0 = performance.now();
  for (const sc of scenariosV2()) {
    if (want && !want.includes(sc.group)) continue;
    const orig = Math.random;
    Math.random = seeded(sc.seed);
    try {
      const { pw, b, A, B } = setup(R, sc);
      const oldFb = new ContactFeedback();
      const oldSample: ContactSample = { touching: false, force: 0, slide: 0, x: 0, y: 0, z: 0, nx: 1, nz: 0, tx: 0, tz: 1 };
      const outerSum = A.spec.outerRadius + B.spec.outerRadius;
      const c = { steps: 0, newQueried: 0, newSkipped: 0, oldQueried: 0, skipWithManifold: 0, oldMissGeometric: 0, oldMissImpulse: 0, oldMissPredictive: 0, geometric: 0, predictive: 0, impulse: 0, geometricZeroImpulse: 0, impulseNoGeometric: 0, newTouching: 0, oldTouching: 0, touchingOnlyNew: 0, touchingOnlyOld: 0, maxTiltOnOldMiss: 0, maxOuterGapOnOldMiss: 0, newSkipOldQuery: 0 };
      const max = (sc.maxSeconds ?? 60) / PHYSICS_DT;
      for (let s = 0; s < max && !b.result; s++) {
        pw.step();
        c.steps++;
        const e = b.contactEvidence;
        const k = b.contactClass;
        const pa = A.body.translation();
        const pb = B.body.translation();
        const dXZ = Math.hypot(pa.x - pb.x, pa.z - pb.z);
        const oldSkip = dXZ > outerSum + 0.12;
        if (e.queried) c.newQueried++;
        else c.newSkipped++;
        if (!oldSkip) c.oldQueried++;
        if (e.skipped && !oldSkip) c.newSkipOldQuery++;
        if (e.skipped) {
          const full = emptyEvidence();
          queryContact(pw.world, A.colliders, B.colliders, full);
          if (full.manifolds > 0) c.skipWithManifold++;
        }
        if (k.geometric) c.geometric++;
        if (k.predictive) c.predictive++;
        if (k.impulseResponse) c.impulse++;
        if (k.geometric && !k.impulseResponse) c.geometricZeroImpulse++;
        if (k.impulseResponse && !k.geometric) c.impulseNoGeometric++;
        if (oldSkip && (k.geometric || k.impulseResponse || k.predictive)) {
          if (k.geometric) c.oldMissGeometric++;
          if (k.impulseResponse) c.oldMissImpulse++;
          if (k.predictive) c.oldMissPredictive++;
          c.maxTiltOnOldMiss = Math.max(c.maxTiltOnOldMiss, A.tilt, B.tilt);
          c.maxOuterGapOnOldMiss = Math.max(c.maxOuterGapOnOldMiss, dXZ - outerSum);
        }
        const newT = e.queried && (k.geometric || k.impulseResponse);
        const oldT = !oldSkip && e.queried && e.impulse > 0;
        if (newT) c.newTouching++;
        if (oldT) c.oldTouching++;
        if (newT && !oldT) c.touchingOnlyNew++;
        if (oldT && !newT) c.touchingOnlyOld++;
        oldSample.touching = oldT;
        oldSample.force = oldT ? e.impulse / PHYSICS_DT : 0;
        oldSample.slide = b.contact.state.slide;
        oldFb.step(PHYSICS_DT, oldSkip ? null : oldSample);
      }
      runs.push({
        name: sc.name,
        group: sc.group,
        seed: sc.seed,
        steps: c.steps,
        result: b.result ? `${b.result.winner}:${b.result.finish}` : 'timeout',
        counts: c,
        feedback: { newEpisodes: b.contact.episodes, oldEpisodes: oldFb.episodes, newGrind: b.contact.grindEpisodes, oldGrind: oldFb.grindEpisodes },
        stats: { ...b.contactStats, contactQueries: b.contactQueries },
      });
      pw.dispose();
    } finally {
      Math.random = orig;
    }
  }
  writeFileSync(out, JSON.stringify({ tune: process.env.DIAG_TUNE ?? null, ms: Math.round(performance.now() - t0), runs }, null, 1));
}, 7_200_000);
