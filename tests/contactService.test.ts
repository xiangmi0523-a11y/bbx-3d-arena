/// <reference types="node" />
/**
 * 阶段 1 第二项 A：只读 ContactService 的接触场景测试与不变量检查。
 *
 * 场景由测试直接摆放陀螺（位置、速度、倾斜、转速），物理、AI、战斗逻辑照常运行；ContactService 只观测。
 * 随机源由 withDeterminism 固定，结果可重复。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { floorHeight } from '../src/game/arena/arenaSpec';
import { createArenaPhysics } from '../src/game/arena/ArenaPhysics';
import { BattleSystem } from '../src/game/battle/BattleSystem';
import { BeyPhysics } from '../src/game/beys/BeyPhysics';
import { assembleBey } from '../src/game/beys/parts/assemble';
import type { BeyLoadout } from '../src/game/beys/parts/types';
import type { BodyPairContact, ColliderPairContact, ContactEvent, ContactService } from '../src/game/physics/ContactService';
import { loadRapier, PhysicsWorld } from '../src/game/physics/PhysicsWorld';
import { contactServiceDigest } from './repro/recorder';
import { withDeterminism } from './repro/determinism';
import { scenariosV2, setup } from './diag/stallprobe2.shared';
import { BAL, DEF_RIVAL, STA } from './motion/scenarios';

type R = Awaited<ReturnType<typeof loadRapier>>;
let R: R;
beforeAll(async () => {
  R = await loadRapier();
});

interface Place {
  x: number;
  z: number;
  vx?: number;
  vz?: number;
  spin?: number;
  tilt?: number;
  tiltAxis?: { x: number; y: number; z: number };
  lift?: number;
}

/** 搭建一场：场地 + 战斗系统 + 摆放的陀螺（null = 不放） */
function arena(p: Place | null, r: Place | null, loadouts: [BeyLoadout, BeyLoadout] = [BAL, DEF_RIVAL], seed = 11) {
  const pw = new PhysicsWorld(R, { observeContacts: true });
  createArenaPhysics(pw);
  const specs = { player: assembleBey(loadouts[0]), rival: assembleBey(loadouts[1]) };
  const b = new BattleSystem(pw, specs);
  pw.beforeStep = (dt) => b.preStep(dt);
  pw.afterStep = (dt) => b.postStep(dt);
  withDeterminism(seed, () => {
    const mk = (pl: Place, spec: typeof specs.player) =>
      new BeyPhysics(pw, spec, {
        position: { x: pl.x, y: floorHeight(Math.hypot(pl.x, pl.z)) + (pl.lift ?? 0.02), z: pl.z },
        velocity: { x: pl.vx ?? 0, y: 0, z: pl.vz ?? 0 },
        spin: pl.spin ?? spec.maxSpin * 0.8,
        tilt: pl.tilt ?? 0,
        tiltAxis: pl.tiltAxis ?? { x: 1, y: 0, z: 0 },
        seed: 7,
      });
    const beys = b.beys as Record<string, BeyPhysics | undefined>;
    if (p) beys.player = mk(p, specs.player);
    if (r) beys.rival = mk(r, specs.rival);
    if (beys.player && beys.rival) {
      beys.player.alignLaunch(beys.rival);
      beys.rival.alignLaunch(beys.player);
    }
  });
  return { pw, b, cs: pw.contacts!, specs };
}

interface StepLog {
  step: number;
  events: ContactEvent[];
  pairs: Map<string, ColliderPairContact & { pts: { x: number; y: number; z: number; nx: number; ny: number; nz: number; dist: number; impulse: number }[] }>;
  bodies: Map<string, BodyPairContact>;
}

/** 推进并逐步复制观测（服务内部对象复用，这里深拷贝） */
function run(pw: PhysicsWorld, cs: ContactService, steps: number, check?: (cs: ContactService) => void): StepLog[] {
  const out: StepLog[] = [];
  for (let s = 0; s < steps; s++) {
    pw.step();
    check?.(cs);
    const pairs = new Map();
    for (const p of cs.colliderPairs) if (p.present || p.phase !== 'none') pairs.set(p.key, { ...p, pts: p.contactPoints.map((q) => ({ ...q })) });
    const bodies = new Map();
    for (const bp of cs.bodyPairs) bodies.set(bp.key, { ...bp });
    out.push({ step: cs.step, events: cs.events.map((e) => ({ ...e })), pairs, bodies });
  }
  return out;
}

const bodyEvents = (log: StepLog[], key: string) => log.flatMap((l) => l.events.filter((e) => e.level === 'body' && e.key === key));
const len3 = (x: number, y: number, z: number) => Math.hypot(x, y, z);

/** 每步都必须成立的不变量 */
function invariants(cs: ContactService): void {
  const seen = new Set<string>();
  const evKeys = new Set<string>();
  for (const e of cs.events) {
    const k = `${e.level}|${e.key}|${e.kind}`;
    expect(evKeys.has(k), `同一步重复事件 ${k}`).toBe(false);
    evKeys.add(k);
    expect(e.step).toBe(cs.step);
    if (e.kind === 'begin') expect([e.startStep, e.durationSteps]).toEqual([cs.step, 1]);
    else expect(e.durationSteps, `${e.key} 结束时长`).toBe(e.step - e.startStep);
  }
  for (const p of cs.colliderPairs) {
    expect(seen.has(p.key), `重复碰撞体对 ${p.key}`).toBe(false);
    seen.add(p.key);
    // 排序：A 在 B 之前（主体优先级，再部件名）
    expect(p.a.rank < p.b.rank || (p.a.rank === p.b.rank && p.a.part < p.b.part), p.key).toBe(true);
    expect(p.a.owner === 'unknown' || p.b.owner === 'unknown', `未知碰撞体 ${p.key}`).toBe(false);
    expect(p.contactPoints.length).toBe(p.solverPoints);
    expect(p.dataStatus).toBe('ok');
    // 证据与分类一致
    expect(p.penetration).toBe(p.solverPoints > 0 && p.minSolverDist <= 0);
    expect(p.impulse).toBe(p.normalImpulse > 0);
    expect(p.physicalContact).toBe(p.penetration || p.impulse);
    if (p.proximity) {
      expect(p.physicalContact).toBe(false);
      expect(p.points).toBeGreaterThan(0);
      expect(p.normalImpulse).toBe(0);
      expect(p.minSolverDist > 0).toBe(true);
    }
    // 结束后不残留
    if (!p.present) {
      expect([p.points, p.solverPoints, p.normalImpulse, +p.physicalContact, +p.proximity, p.contactPoints.length]).toEqual([0, 0, 0, 0, 0, 0]);
    }
    expect(p.phase === 'none' ? !p.physicalContact : p.physicalContact, `${p.key} 生命周期与证据`).toBe(true);
    if (p.phase !== 'none') expect(p.durationSteps).toBe(cs.step - p.startStep + 1);
    let sum = 0;
    for (const q of p.contactPoints) {
      if (q.normalValid) expect(Math.abs(len3(q.nx, q.ny, q.nz) - 1), `${p.key} 法线单位长度`).toBeLessThan(1e-5);
      else expect([q.nx, q.ny, q.nz, q.dist], `${p.key} 无效法线只出现在恰好相切时`).toEqual([0, 0, 0, 0]);
      expect(q.impulse).toBeGreaterThanOrEqual(0);
      sum += q.impulse;
    }
    expect(Math.abs(sum - p.normalImpulse)).toBeLessThan(1e-9);
  }
  for (const bp of cs.bodyPairs) {
    expect(bp.phase === 'none' ? !bp.physicalContact : bp.physicalContact, bp.key).toBe(true);
    const members = cs.colliderPairs.filter((p) => p.present && [p.a.owner, p.b.owner].sort().join() === [bp.a, bp.b].sort().join());
    expect(bp.physicalContact).toBe(members.some((p) => p.physicalContact));
    expect(bp.colliderPairs).toBe(members.length);
  }
}

describe('ContactService 只读接触观测', () => {
  it('1 无接触：两台相距很远时没有陀螺之间的接触，也没有把预测间隙当成接触', () => {
    const { pw, b, cs, specs } = arena({ x: -2.6, z: 0 }, { x: 2.6, z: 0 });
    // 两台会在 AI 驱动下靠近（约 80 步后相遇），只看前 45 步，并确认这段时间里中心距始终远大于刀刃半径和
    const reach = specs.player.outerRadius + specs.rival.outerRadius;
    const log = run(pw, cs, 45, (c) => {
      invariants(c);
      const pa = b.beys.player!.body.translation();
      const pb = b.beys.rival!.body.translation();
      expect(Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z)).toBeGreaterThan(reach + 1);
    });
    expect(bodyEvents(log, 'player|rival')).toEqual([]);
    expect(log.every((l) => !l.bodies.get('player|rival')?.physicalContact)).toBe(true);
    // 同时，地面接触是真实存在并被观测到的（不是“什么都没采到”）
    expect(log.some((l) => l.bodies.get('player|arena')?.physicalContact)).toBe(true);
    pw.dispose();
  });

  it('2 正面接触：开始事件、刀刃层身份、法线从 A 指向 B、冲量 > 0', () => {
    const { pw, b, cs } = arena({ x: -0.75, z: 0, vx: 2.5 }, { x: 0.75, z: 0, vx: -2.5 });
    let normalChecked = 0;
    const log = run(pw, cs, 120, (c) => {
      invariants(c);
      for (const p of c.colliderPairs) {
        if (!(p.physicalContact && p.a.owner === 'player' && p.b.owner === 'rival')) continue;
        const pa = b.beys.player!.body.translation();
        const pb = b.beys.rival!.body.translation();
        const d = Math.hypot(pb.x - pa.x, pb.z - pa.z);
        for (const q of p.contactPoints) {
          // 水平分量与 player→rival 连线同向
          expect(((pb.x - pa.x) * q.nx + (pb.z - pa.z) * q.nz) / d, p.key).toBeGreaterThan(0.5);
          normalChecked++;
        }
      }
    });
    const begins = bodyEvents(log, 'player|rival').filter((e) => e.kind === 'begin');
    expect(begins.length).toBeGreaterThanOrEqual(1);
    const at = log.find((l) => l.step === begins[0].step)!;
    const parts = [...at.pairs.values()].filter((p) => p.physicalContact && p.a.owner === 'player' && p.b.owner === 'rival').map((p) => p.key);
    expect(parts.length).toBeGreaterThan(0);
    for (const k of parts) expect(k).toMatch(/^player:(blade|ratchet)\|rival:(blade|ratchet)$/);
    expect(normalChecked).toBeGreaterThan(0);
    expect(log.some((l) => (l.bodies.get('player|rival')?.normalImpulse ?? 0) > 0)).toBe(true);
    pw.dispose();
  });

  it('3 倾斜边缘接触：被检测到，法线方向一致，接触点高度与竖直时不同', () => {
    const heights = (tilt: number) => {
      // player 朝 rival 方向（+x）倾斜：绕 z 轴转负角度，刀刃 +x 侧向下
      const { pw, b, cs } = arena({ x: -0.72, z: 0, vx: 1.8, tilt, tiltAxis: { x: 0, y: 0, z: -1 } }, { x: 0.72, z: 0, vx: -1.8 });
      const ys: number[] = [];
      const log = run(pw, cs, 60, (c) => {
        invariants(c);
        const bp = c.bodyPair('player', 'rival');
        if (bp?.physicalContact && bp.deepestPair?.deepest) {
          const q = bp.deepestPair.deepest;
          ys.push(q.y - b.beys.player!.body.translation().y);
          expect(q.nx).toBeGreaterThan(0);
        }
      });
      pw.dispose();
      return { ys, begins: bodyEvents(log, 'player|rival').filter((e) => e.kind === 'begin').length };
    };
    const upright = heights(0);
    const tilted = heights(0.3);
    expect(tilted.begins).toBeGreaterThanOrEqual(1);
    expect(tilted.ys.length).toBeGreaterThan(0);
    expect(Math.abs(tilted.ys[0] - upright.ys[0])).toBeGreaterThan(0.005);
  });

  it('4 多接触点与持续接触：同一碰撞体对的多个接触点分别报告、不合并；持续接触只有一个生命周期', () => {
    // 不转、倾斜摆放的陀螺会倒在碗底，Blade 圆柱压在三角网格上，产生多个接触点；静止后持续接触
    const { pw, cs } = arena({ x: 0, z: 0, spin: 0, tilt: 0.6, tiltAxis: { x: 0, y: 0, z: 1 } }, null);
    let multi = 0;
    let multiManifold = 0;
    run(pw, cs, 360, (c) => {
      invariants(c);
      for (const p of c.colliderPairs) {
        if (p.contactPoints.length < 2) continue;
        multi++;
        if (p.manifolds > 1) multiManifold++;
        // 同一流形内的接触点互不重合（Rapier 给出的每个点都原样保留）；
        // 不同流形可以给出几乎重合的点（球压在三角网格顶点上时，每个相邻三角形各一个流形），也原样保留，不去重
        for (let i = 0; i < p.contactPoints.length; i++)
          for (let j = i + 1; j < p.contactPoints.length; j++) {
            const u = p.contactPoints[i];
            const v = p.contactPoints[j];
            if (u.manifold === v.manifold) expect(len3(u.x - v.x, u.y - v.y, u.z - v.z), `${p.key} 同一流形内接触点重合`).toBeGreaterThan(1e-5);
          }
      }
    });
    expect(multi).toBeGreaterThan(0);
    expect(multiManifold).toBeGreaterThan(0);
    const body = cs.bodyPair('player', 'arena')!;
    expect(body.phase).not.toBe('none');
    expect(body.durationSteps).toBeGreaterThan(120);
    pw.dispose();
  });

  it('5、6 接触后分离、再次接触：结束事件时长按步数，再次接触开启新的接触段', () => {
    const { pw, cs } = arena({ x: -0.9, z: 0.2, vx: 3 }, { x: 0.9, z: -0.2, vx: -3 }, [BAL, DEF_RIVAL], 3);
    const log = run(pw, cs, 1200, invariants);
    const ev = bodyEvents(log, 'player|rival');
    const begins = ev.filter((e) => e.kind === 'begin');
    const ends = ev.filter((e) => e.kind === 'end');
    expect(begins.length).toBeGreaterThanOrEqual(2);
    expect(ends.length).toBeGreaterThanOrEqual(1);
    // 交替出现：begin、end、begin……；每个 end 对应前一个 begin
    for (let i = 0; i < ev.length; i++) expect(ev[i].kind).toBe(i % 2 === 0 ? 'begin' : 'end');
    for (let i = 1; i < ev.length; i += 2) {
      expect(ev[i].startStep).toBe(ev[i - 1].step);
      expect(ev[i].durationSteps).toBe(ev[i].step - ev[i - 1].step);
      // 结束那一步及之后，直到下一次开始之前，都没有身体级真实接触
      const next = ev[i + 1]?.step ?? Infinity;
      for (const l of log) if (l.step >= ev[i].step && l.step < next) expect(l.bodies.get('player|rival')?.physicalContact ?? false).toBe(false);
    }
    expect(cs.bodyPair('player', 'rival')!.episodes).toBe(begins.length);
    pw.dispose();
  });

  it('7 墙壁与地面接触：身份、法线（陀螺 → 场地）方向', () => {
    // 靠近外墙、朝外高速移动
    const r0 = 4.6;
    const { pw, b, cs } = arena({ x: r0, z: 0, vx: 6 }, null);
    let wall = 0;
    let floor = 0;
    run(pw, cs, 90, (c) => {
      invariants(c);
      const pos = b.beys.player!.body.translation();
      for (const p of c.colliderPairs) {
        if (!p.physicalContact) continue;
        expect(p.a.owner).toBe('player');
        expect(p.b.owner).toBe('arena');
        for (const q of p.contactPoints) {
          if (p.b.part.startsWith('wall#')) {
            wall++;
            const rr = Math.hypot(pos.x, pos.z);
            expect((q.nx * pos.x + q.nz * pos.z) / rr, '墙壁法线朝外').toBeGreaterThan(0.5);
          }
          if (p.b.part === 'floor' && p.a.part === 'bit') {
            floor++;
            expect(q.ny, '地面法线向下（陀螺 → 地面）').toBeLessThan(-0.5);
          }
        }
      }
    });
    expect(wall).toBeGreaterThan(0);
    expect(floor).toBeGreaterThan(0);
    pw.dispose();
  });

  it('8 同一台陀螺的多个碰撞体：碰撞体级分别记录，身体级合并为一个接触段', () => {
    const { pw, cs } = arena({ x: 2.5, z: 0, spin: 0, tilt: 0.6, tiltAxis: { x: 0, y: 0, z: 1 } }, null);
    let multiCollider = 0;
    const log = run(pw, cs, 360, (c) => {
      invariants(c);
      const bp = c.bodyPair('player', 'arena');
      if (bp && bp.physicalPairs >= 2) multiCollider++;
    });
    expect(multiCollider).toBeGreaterThan(0);
    const colliderBegins = log.flatMap((l) => l.events.filter((e) => e.level === 'collider' && e.kind === 'begin' && e.key.startsWith('player:')));
    const keys = new Set(colliderBegins.map((e) => e.key.split('|')[0]));
    expect(keys.size).toBeGreaterThanOrEqual(2);
    // 身体级段数少于碰撞体级段数之和（多个碰撞体同时接触时只算一段）
    expect(cs.bodyPair('player', 'arena')!.episodes).toBeLessThan(colliderBegins.length);
    pw.dispose();
  });
});

describe('ContactService 在真实对局上的不变量与读写边界', () => {
  const all = scenariosV2();
  const sample = all.filter((s, i) => all.findIndex((x) => x.group === s.group) === i);

  it('每组第一场：每步不变量成立；遍历顺序反转时输出逐步相同；不读取时间与随机数', () => {
    for (const sc of sample) {
      const digests: string[][] = [];
      for (const reverse of [false, true]) {
        const d: string[] = [];
        const { report } = withDeterminism(sc.seed, (live) => {
          const { pw, b } = setup(R, sc, { observeContacts: true });
          const cs = pw.contacts!;
          cs.reverseEnumeration = reverse;
          const world = pw.world;
          const engineStep = world.step.bind(world);
          world.step = ((...a: Parameters<typeof world.step>) => {
            live.inEngine = true;
            try {
              return engineStep(...a);
            } finally {
              live.inEngine = false;
            }
          }) as typeof world.step;
          const steps = Math.min(1800, (sc.maxSeconds ?? 60) * 120);
          for (let s = 0; s < steps && !b.result; s++) {
            pw.step();
            if (!reverse) invariants(cs);
            d.push(contactServiceDigest(cs));
          }
          pw.dispose();
        });
        expect(report.bypass, sc.name).toEqual({ performanceNow: 0, dateNow: 0, cryptoRandom: 0 });
        digests.push(d);
      }
      expect(digests[1].length, sc.name).toBe(digests[0].length);
      const first = digests[0].findIndex((x, i) => x !== digests[1][i]);
      expect(first, `${sc.name} 遍历顺序反转后第一个不同的步`).toBe(-1);
    }
  }, 600000);

  it('显式关闭观测时不创建服务、不注册身份（M2 起默认开启，供爆裂与自灭判定使用）', () => {
    const pw = new PhysicsWorld(R, { observeContacts: false });
    createArenaPhysics(pw);
    expect(pw.contacts).toBeNull();
    pw.dispose();
  });

  it('STA 针尖持续贴地时，生命周期与真实证据一致（离地多步后才结束）', () => {
    const { pw, cs } = arena({ x: 0, z: 0, spin: 600 }, null, [STA, DEF_RIVAL]);
    const log = run(pw, cs, 240, invariants);
    // 每个结束事件之前的那一步必须有真实证据，结束那一步必须没有
    const ev = log.flatMap((l) => l.events.filter((e) => e.kind === 'end' && e.key === 'player:bit|arena:floor'));
    for (const e of ev) {
      const before = log.find((l) => l.step === e.step - 1)!.pairs.get(e.key)!;
      const at = log.find((l) => l.step === e.step)!.pairs.get(e.key);
      expect(before.physicalContact).toBe(true);
      expect(at?.physicalContact ?? false).toBe(false);
    }
    pw.dispose();
  });
});
