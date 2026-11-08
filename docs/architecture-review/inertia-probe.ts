import RAPIER from '@dimforge/rapier3d-compat';
import { assembleBey } from '../v1/src/game/beys/parts/assemble';
import { listParts } from '../v1/src/game/beys/parts/catalog';
import { PhysicsWorld } from '../v1/src/game/physics/PhysicsWorld';
import { BeyPhysics, BEY_TUNING } from '../v1/src/game/beys/BeyPhysics';
import { profileOf, INTENT_TUNING } from '../v1/src/game/beys/motionIntent';
await RAPIER.init();
const pw = new PhysicsWorld(RAPIER as any);
const rows:any[] = [];
for (const b of listParts('blade')) for (const t of listParts('tip')) {
  const spec = assembleBey({ blade: b.id, disc: 'hex-lock', tip: t.id });
  const bey = new BeyPhysics(pw, spec, { position:{x:0,y:2,z:0}, velocity:{x:0,y:0,z:0}, spin:100, seed:1 });
  const I = bey.body.principalInertia();
  const P = profileOf(spec);
  const aMax = Math.min(INTENT_TUNING.authorityCap, 0.95 * P.tipAuthority); // 最大状态深度≈cutA0+cutA1*attack ≤0.95
  const bias = aMax > 0 ? (1 - Math.sqrt(1 - aMax*aMax)) / aMax : 0;
  rows.push({ blade: b.id, tip: t.id, specI: +spec.spinInertia.toFixed(3), rapierIy: +I.y.toFixed(3), ratio: +(I.y/spec.spinInertia).toFixed(2),
    drives: t.gearGrip >= BEY_TUNING.driveMinGrip, tipAuth: +P.tipAuthority.toFixed(2), maxAuthority: +aMax.toFixed(2), meanBias: +bias.toFixed(2),
    rollDecel: +((BEY_TUNING.rollBase + BEY_TUNING.rollFriction*t.friction)*20).toFixed(3), driveAccelMax: +(BEY_TUNING.driveAccel*t.gearGrip).toFixed(1) });
  bey.dispose();
}
console.table(rows);
