/// <reference types="node" />
/**
 * 关键物理参数指纹：任何一项变化，指纹就变。用来区分“行为变了”是因为代码逻辑还是参数 / 引擎版本。
 * 覆盖：部件物理字段（不含视觉）、BEY_TUNING、INTENT_TUNING、SMASH_TUNING、CONTACT_TUNING、撞击分档阈值、
 * 接触采样常量、物理步长 / 重力 / 求解器参数、场地参数、Rapier 版本。
 */
import { createHash } from 'node:crypto';
import { ARENA } from '../../src/game/arena/arenaSpec';
import { TABLE_Y } from '../../src/game/arena/ArenaPhysics';
import { SMASH_TUNING } from '../../src/game/battle/BattleSystem';
import { CONTACT_TUNING } from '../../src/game/battle/contactFeedback';
import { BOUND_MARGIN, SHAPE_RANGE } from '../../src/game/battle/contactSampling';
import { TIER_THRESHOLDS } from '../../src/game/battle/impactTiers';
import { BEY_TUNING } from '../../src/game/beys/BeyPhysics';
import { INTENT_TUNING } from '../../src/game/beys/motionIntent';
import { listParts } from '../../src/game/beys/parts/catalog';
import type { PartSpec } from '../../src/game/beys/parts/types';
import { GRAVITY, PHYSICS_HZ, PhysicsWorld, type Rapier } from '../../src/game/physics/PhysicsWorld';

const physicsOf = (p: PartSpec) => Object.fromEntries(Object.entries(p).filter(([k]) => !['visual', 'name', 'desc', 'code'].includes(k)));

export function configSnapshot(R: Rapier) {
  const pw = new PhysicsWorld(R);
  const ip = pw.world.integrationParameters;
  const solver = {
    timestep: pw.world.timestep,
    dt: ip.dt,
    contactErp: ip.contact_erp,
    lengthUnit: ip.lengthUnit,
    numSolverIterations: ip.numSolverIterations,
    numInternalPgsIterations: ip.numInternalPgsIterations,
    normalizedAllowedLinearError: ip.normalizedAllowedLinearError,
    normalizedPredictionDistance: ip.normalizedPredictionDistance,
    minIslandSize: ip.minIslandSize,
    maxCcdSubsteps: ip.maxCcdSubsteps,
  };
  pw.dispose();
  const parts = [...listParts('blade'), ...listParts('ratchet'), ...listParts('bit')].map((p) => [`${p.kind}:${p.id}`, physicsOf(p)]);
  return {
    rapier: R.version(),
    physicsHz: PHYSICS_HZ,
    gravity: GRAVITY,
    solver,
    arena: ARENA,
    tableY: TABLE_Y,
    parts: Object.fromEntries(parts),
    bey: BEY_TUNING,
    intent: INTENT_TUNING,
    smash: SMASH_TUNING,
    contact: CONTACT_TUNING,
    tiers: TIER_THRESHOLDS,
    sampling: { SHAPE_RANGE, BOUND_MARGIN },
  };
}

let cached: { R: Rapier; hash: string } | null = null;
export function configFingerprint(R: Rapier): string {
  if (cached?.R === R) return cached.hash;
  const hash = createHash('sha256').update(JSON.stringify(configSnapshot(R))).digest('hex').slice(0, 16);
  cached = { R, hash };
  return hash;
}
