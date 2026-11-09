/**
 * 低速停滞探针 V2：场景矩阵、对局搭建、逐步状态指纹、无探针对照。
 *
 * 这个文件只依赖 cb4c2c4 就已存在的公开接口（BattleSystem / BeyPhysics 构造与 launch / assembleBey / scenarios），
 * 可以原样复制到干净的 cb4c2c4 工作树里跑无探针对照（跨树基线验证），两边场景与种子逐字相同。
 *
 * 场景分三类：
 *  - 自然对局：tests/motion/scenarios.ts 全部分组 + FEELBAL/FEELSTA（physics.test 用例的发射方式，120 s）
 *  - NNPOW：针尖对针尖，低功率 0.3 / 0.45 与正常功率 0.9，各 4 个种子，120 s
 *  - CTRL：受控初始条件（只改开局摆放，物理代码不变）——碗底双停 / 墙边贴靠 / 轻擦，三种陀尖组合，各 2 个种子
 */
import { createHash } from 'node:crypto';
import { floorHeight } from '../../src/game/arena/arenaSpec';
import { createArenaPhysics } from '../../src/game/arena/ArenaPhysics';
import { BattleSystem } from '../../src/game/battle/BattleSystem';
import { BeyPhysics } from '../../src/game/beys/BeyPhysics';
import { assembleBey } from '../../src/game/beys/parts/assemble';
import type { BeyLoadout } from '../../src/game/beys/parts/types';
import { rivalCommand } from '../../src/game/launcher/launch';
import { loadRapier, PhysicsWorld, PHYSICS_DT } from '../../src/game/physics/PhysicsWorld';
import { seeded, type MotionScenario } from '../motion/motionSim';
import { ATK, BAL, DEF_RIVAL, groups, STA } from '../motion/scenarios';

export type R = Awaited<ReturnType<typeof loadRapier>>;

/** 受控摆放：两台中点所在半径 / 方位角，中心距 = 刀刃半径和 + gap，连线方向与径向夹角 lineAng，相向速度 closing，转速 spinFrac × maxSpin */
export interface Place {
  kind: 'center' | 'wall' | 'graze';
  r: number;
  ang: number;
  gap: number;
  lineAng: number;
  closing: number;
  spinFrac: number;
}

export interface Scn extends MotionScenario {
  group: string;
  feel?: boolean;
  place?: Place;
  /** 初始条件说明（写进报告的场景表） */
  init: string;
}

const STA2: BeyLoadout = { ...STA, blade: 'tidal-bastion' };
const COMBOS: { key: string; p: BeyLoadout; r: BeyLoadout }[] = [
  { key: 'NN', p: STA, r: STA2 },
  { key: 'BB', p: BAL, r: DEF_RIVAL },
  { key: 'NR', p: STA, r: ATK },
];

export function scenariosV2(): Scn[] {
  const out: Scn[] = [];
  for (const g of groups())
    for (const sc of g.scenarios) out.push({ ...sc, group: g.key, init: `发射 p=${sc.pCmd.power}/${sc.rCmd.power} aim=${sc.pCmd.aim}/${sc.rCmd.aim}${sc.phase ? ' 指定进动相位' : ''}` });
  const RIVAL: BeyLoadout = { blade: 'tidal-bastion', disc: 'hex-lock', tip: 'dome-ball' };
  const z = { power: 0, aim: 0, tilt: 0 };
  for (let i = 0; i < 6; i++) out.push({ name: `FEELBAL#${1000 + i}`, group: 'FEELBAL', player: BAL, rival: RIVAL, pCmd: z, rCmd: z, seed: 1000 + i, maxSeconds: 120, feel: true, init: 'feelRun 随机发射（种子决定）' });
  for (let i = 0; i < 4; i++) out.push({ name: `FEELSTA#${3000 + i}`, group: 'FEELSTA', player: STA, rival: STA2, pCmd: z, rCmd: z, seed: 3000 + i, maxSeconds: 120, feel: true, init: 'feelRun 随机发射（种子决定）' });
  // 针尖对针尖：低功率 / 正常功率
  [0.3, 0.45, 0.9].forEach((pow, k) => {
    for (let i = 0; i < 4; i++) {
      const aim = [0, 0.3, -0.3, 0.6][i];
      out.push({ name: `NNPOW ${pow}#${i}`, group: 'NNPOW', player: STA, rival: STA2, pCmd: { power: pow, aim, tilt: 0 }, rCmd: { power: pow, aim: -aim / 2, tilt: 0 }, seed: 4000 + k * 10 + i, maxSeconds: 120, init: `发射 p=${pow}/${pow} aim=${aim}/${-aim / 2}` });
    }
  });
  // 受控摆放
  const places: Place[] = [
    { kind: 'center', r: 0, ang: 0, gap: 0.01, lineAng: Math.PI / 2, closing: 0, spinFrac: 0.75 },
    { kind: 'wall', r: 4.5, ang: Math.PI / 2, gap: 0.01, lineAng: Math.PI / 2, closing: 0, spinFrac: 0.75 },
    { kind: 'graze', r: 1.2, ang: Math.PI / 2, gap: 0.004, lineAng: Math.PI / 2, closing: 0.15, spinFrac: 0.75 },
  ];
  places.forEach((pl, pk) =>
    COMBOS.forEach((c, ck) => {
      for (let i = 0; i < 2; i++)
        out.push({
          name: `CTRL ${pl.kind} ${c.key}#${i}`,
          group: 'CTRL',
          player: c.p,
          rival: c.r,
          pCmd: z,
          rCmd: z,
          seed: 5000 + pk * 100 + ck * 10 + i,
          maxSeconds: 60,
          place: pl,
          init: `摆放 ${pl.kind}：中点 r=${pl.r} 中心距=刀刃和+${pl.gap} 相向 ${pl.closing} m/s 转速 ${pl.spinFrac}×max`,
        });
    }),
  );
  return out;
}

/** 受控摆放：与 BattleSystem.launch 相同的步骤（替换实例 → 双方 alignLaunch），只是发射参数由摆放给出 */
function placeBeys(pw: PhysicsWorld, b: BattleSystem, sc: Scn): [BeyPhysics, BeyPhysics] {
  const pl = sc.place!;
  const specs = [assembleBey(sc.player), assembleBey(sc.rival)];
  const sep = specs[0].blade.radius + specs[1].blade.radius + pl.gap;
  const mx = Math.cos(pl.ang) * pl.r;
  const mz = Math.sin(pl.ang) * pl.r;
  // 连线方向：径向方向旋转 lineAng（中点在圆心时取 x 轴）
  const base = pl.r > 0 ? pl.ang : 0;
  const lx = Math.cos(base + pl.lineAng);
  const lz = Math.sin(base + pl.lineAng);
  const beys = ([-1, 1] as const).map((sgn, i) => {
    const x = mx + (sgn * lx * sep) / 2;
    const zz = mz + (sgn * lz * sep) / 2;
    const r = Math.hypot(x, zz);
    return new BeyPhysics(pw, specs[i], {
      position: { x, y: floorHeight(r) + 0.12, z: zz },
      velocity: { x: -sgn * lx * pl.closing, y: 0, z: -sgn * lz * pl.closing },
      spin: specs[i].maxSpin * pl.spinFrac,
      tilt: 0,
      tiltAxis: { x: -lz, y: 0, z: lx },
    });
  });
  const bb = b.beys as Record<string, BeyPhysics | undefined>;
  bb.player?.dispose();
  bb.rival?.dispose();
  bb.player = beys[0];
  bb.rival = beys[1];
  beys[0].alignLaunch(beys[1]);
  beys[1].alignLaunch(beys[0]);
  return [beys[0], beys[1]];
}

export function setup(R: R, sc: Scn, opts: { observeContacts?: boolean } = {}) {
  const pw = new PhysicsWorld(R, opts);
  createArenaPhysics(pw);
  const b = new BattleSystem(pw, { player: assembleBey(sc.player), rival: assembleBey(sc.rival) });
  pw.beforeStep = (dt) => b.preStep(dt);
  pw.afterStep = (dt) => b.postStep(dt);
  let A: BeyPhysics;
  let B: BeyPhysics;
  if (sc.place) {
    [A, B] = placeBeys(pw, b, sc);
  } else if (sc.feel) {
    const rnd = Math.random;
    A = b.launch('player', { power: 0.6 + rnd() * 0.35, aim: (rnd() - 0.5) * 0.8, tilt: 0 });
    B = b.launch('rival', rivalCommand(rnd));
  } else {
    A = b.launch('player', sc.pCmd);
    B = b.launch('rival', sc.rCmd);
    if (sc.phase) {
      (A as unknown as { precession: number }).precession = sc.phase[0];
      (B as unknown as { precession: number }).precession = sc.phase[1];
    }
  }
  return { pw, b, A, B };
}

/** 状态指纹（逐步）：位置、姿态、速度、角速度、转速、倾斜（float64 原值） */
export function fingerprint(h: ReturnType<typeof createHash>, beys: BeyPhysics[]) {
  const f = new Float64Array(15 * beys.length);
  let k = 0;
  for (const x of beys) {
    const p = x.body.translation();
    const q = x.body.rotation();
    const v = x.body.linvel();
    const w = x.body.angvel();
    f.set([p.x, p.y, p.z, q.x, q.y, q.z, q.w, v.x, v.y, v.z, w.x, w.y, w.z, x.spin, x.tilt], k);
    k += 15;
  }
  h.update(Buffer.from(f.buffer));
}

/** 无探针对照：只跑物理，返回逐步指纹 */
export async function plainRun(R: R, sc: Scn): Promise<{ hash: string; steps: number; result: string; breakouts: number; wobbleBreaks: number }> {
  const orig = Math.random;
  Math.random = seeded(sc.seed);
  try {
    const { pw, b, A, B } = setup(R, sc);
    const h = createHash('sha256');
    const max = (sc.maxSeconds ?? 60) / PHYSICS_DT;
    let s = 0;
    for (; s < max && !b.result; s++) {
      pw.step();
      fingerprint(h, [A, B]);
    }
    const out = { hash: h.digest('hex'), steps: s, result: b.result ? `${b.result.winner}:${b.result.finish}` : 'timeout', breakouts: b.breakouts, wobbleBreaks: b.wobbleBreaks };
    pw.dispose();
    return out;
  } finally {
    Math.random = orig;
  }
}
