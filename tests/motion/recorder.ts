/**
 * 对局逐帧录制器（真实物理，无头，固定种子）。供浏览器回放对比页 tools/replay 使用。
 *
 * 与 motionSim 同一套输入（场景 / 种子 / Math.random 覆盖方式完全相同），
 * 只用基线 0dac2ad 与新版本都有的接口，所以同一份文件可以原样拷到基线工作树里运行。
 * 每 2 个物理步（60 Hz）记一帧：双方位置、自转轴、转速、速度、进动相位、运动状态、冲刺、贴墙、
 * 中心距与接触标志；另外按事件记录撞击（等级 / 强度 / 接近速度）、接触段（开始时的切入角分解）、撞墙。
 *
 * 只读物理状态，不写入任何东西（除了与 motionSim 相同的可选初相覆盖），所以录制结果与无头统计逐步一致。
 */
import { createArenaPhysics } from '../../src/game/arena/ArenaPhysics';
import { BattleSystem } from '../../src/game/battle/BattleSystem';
import type { BeyPhysics } from '../../src/game/beys/BeyPhysics';
import { assembleBey } from '../../src/game/beys/parts/assemble';
import { loadRapier, PhysicsWorld, PHYSICS_DT } from '../../src/game/physics/PhysicsWorld';
import { seeded, type MotionScenario } from './motionSim';

/** 状态名表（回放里用下标存，节省体积） */
export const STATES = ['cut', 'orbit', 'contact', 'disengage', 'guard', 'roam', 'evade', 'breakout', 'charge', 'backoff', 'recoil', 'launch'];

export function stateOf(b: BeyPhysics): string {
  const x = b as unknown as { intentState?: string; charging?: boolean; recoil?: number; breakout?: number };
  if (typeof x.intentState === 'string') return x.intentState;
  if ((x.breakout ?? 0) > 0) return 'breakout';
  if ((x.recoil ?? 0) > 0) return 'recoil';
  return x.charging ? 'charge' : 'backoff';
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export interface ContactRec {
  /** 开始 / 结束时间 */
  t0: number;
  t1: number;
  /** 开始时相对速度与连心线夹角（度）——与 motionSim 的 cutAngle 同一定义 */
  cut: number;
  /** 开始时相对速度的法向（接近）与切向分量（m/s） */
  vn: number;
  vt: number;
  /** 双方各自速度在连心线切向上的分量（m/s，同一切向基，正 = 逆时针绕连心线中点） */
  vtA: number;
  vtB: number;
  /** 双方各自速度大小 */
  spA: number;
  spB: number;
  /** 开始前 0.5 s 双方状态（出现次数最多的） */
  stA: string;
  stB: string;
  /** 开始时双方状态 */
  stA0: string;
  stB0: string;
  /** 接触期间中心距最小值 */
  dMin: number;
  /** 接触期间双方连心线转过的角度（rad，正 = 逆时针）：互相绕着转多少 */
  losTurn: number;
  /** 接触期间双方离场地中心的平均距离 */
  rMean: number;
  /** 接触期间撞击次数（> minEventDv 的）与轻擦被并掉的次数 */
  hits: number;
  /** 期间双方平均速度 */
  speedMean: number;
  /** 接触段内双方转速损失（比例） */
  spinLossA: number;
  spinLossB: number;
}

export interface WallRec {
  t: number;
  side: 0 | 1;
  state: string;
  dash: boolean;
  /** 撞墙前 0.5 s 的状态序列（去重） */
  hist: string[];
  /** 撞墙时水平速度、径向分量 */
  speed: number;
  vRad: number;
  /** 撞墙前 0.6 s 内最近一次接触结束的时间差（无则 NaN） */
  sinceContact: number;
  /** 撞墙前 0.6 s 内最近一次撞击的等级（无则空） */
  lastImpact: string;
}

export interface Replay {
  version: string;
  scenario: MotionScenario;
  dt: number;
  /** 帧：[t, d, contact, ...A(13), ...B(13)]；每台：x y z ux uy uz spin spinRatio vx vz prec state(下标) flags(1 冲刺 | 2 贴墙) */
  frames: number[][];
  spinSign: [number, number];
  /** 刀刃碰撞半径、外沿半径 */
  bladeR: [number, number];
  outerR: [number, number];
  contactR: number;
  impacts: { t: number; tier: string; strength: number; approach: number; x: number; z: number }[];
  contacts: ContactRec[];
  walls: WallRec[];
  result: string;
  duration: number;
  hits: number;
  strong: number;
}

const FRAME_STRIDE = 2;

export async function recordReplay(sc: MotionScenario, version: string): Promise<Replay> {
  const orig = Math.random;
  Math.random = seeded(sc.seed);
  try {
    const R = await loadRapier();
    const pw = new PhysicsWorld(R);
    const arena = createArenaPhysics(pw);
    const wallSet = new Set(arena.walls.map((c) => c.handle));
    const battle = new BattleSystem(pw, { player: assembleBey(sc.player), rival: assembleBey(sc.rival) });
    pw.beforeStep = (dt) => battle.preStep(dt);
    pw.afterStep = (dt) => battle.postStep(dt);
    const A = battle.launch('player', sc.pCmd);
    const B = battle.launch('rival', sc.rCmd);
    if (sc.phase) {
      (A as unknown as { precession: number }).precession = sc.phase[0];
      (B as unknown as { precession: number }).precession = sc.phase[1];
    }
    const beys = [A, B];
    const contactR = A.spec.blade.radius + B.spec.blade.radius + 0.03;
    const max = (sc.maxSeconds ?? 60) / PHYSICS_DT;
    const frames: number[][] = [];
    const impacts: Replay['impacts'] = [];
    const contacts: ContactRec[] = [];
    const walls: WallRec[] = [];
    const onWall = [false, false];
    const stHist: string[][] = [[], []];
    let touching = false;
    let cur: (ContactRec & { _sp: number; _n: number; _r: number; _los: number; _s0: [number, number] }) | null = null;
    let lastContactEnd = -1;
    let lastImpact = { t: -1, tier: '' };
    let steps = 0;
    const prec = (b: BeyPhysics) => (b as unknown as { precession: number }).precession;
    const modal = (h: string[]) => {
      const c: Record<string, number> = {};
      for (const s of h) c[s] = (c[s] ?? 0) + 1;
      return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
    };

    for (; steps < max && !battle.result; steps++) {
      const nImp = battle.impacts.length;
      pw.step();
      const t = (steps + 1) * PHYSICS_DT;
      for (let k = nImp; k < battle.impacts.length; k++) {
        const e = battle.impacts[k];
        impacts.push({ t: r3(t), tier: e.tier, strength: r3(e.strength), approach: r3(e.approach), x: r3(e.x), z: r3(e.z) });
        lastImpact = { t, tier: e.tier };
        if (cur) cur.hits++;
      }
      const pa = A.body.translation();
      const pb = B.body.translation();
      const dx = pb.x - pa.x;
      const dz = pb.z - pa.z;
      const d = Math.hypot(dx, dz);
      const now = d < contactR;
      const sts = beys.map(stateOf);
      for (let i = 0; i < 2; i++) {
        stHist[i].push(sts[i]);
        if (stHist[i].length > 60) stHist[i].shift();
      }
      // 撞墙
      const wallNow = [false, false];
      for (let i = 0; i < 2; i++) {
        let tw = false;
        for (const c of beys[i].colliders) {
          pw.world.contactPairsWith(c, (o) => {
            if (wallSet.has(o.handle)) tw = true;
          });
        }
        wallNow[i] = tw;
        if (tw && !onWall[i]) {
          const b = beys[i];
          const p = b.body.translation();
          const v = b.body.linvel();
          const rr = Math.hypot(p.x, p.z) || 1;
          const seq: string[] = [];
          for (const s of stHist[i]) if (seq[seq.length - 1] !== s) seq.push(s);
          walls.push({
            t: r3(t),
            side: i as 0 | 1,
            state: sts[i],
            dash: b.dashing,
            hist: seq,
            speed: r3(Math.hypot(v.x, v.z)),
            vRad: r3((v.x * p.x + v.z * p.z) / rr),
            sinceContact: touching || now ? 0 : lastContactEnd > 0 && t - lastContactEnd < 0.6 ? r3(t - lastContactEnd) : NaN,
            lastImpact: lastImpact.t > 0 && t - lastImpact.t < 0.6 ? lastImpact.tier : '',
          });
        }
        onWall[i] = tw;
      }
      // 接触段
      const va = A.body.linvel();
      const vb = B.body.linvel();
      if (now && !touching) {
        const nx = dx / (d || 1);
        const nz = dz / (d || 1);
        const tx = -nz;
        const tz = nx;
        const rx = va.x - vb.x;
        const rz = va.z - vb.z;
        const rl = Math.hypot(rx, rz);
        const vn = rx * nx + rz * nz;
        const vt = rx * tx + rz * tz;
        cur = {
          t0: r3(t),
          t1: r3(t),
          cut: rl > 0.3 ? r3((Math.acos(Math.max(-1, Math.min(1, vn / rl))) * 180) / Math.PI) : NaN,
          vn: r3(vn),
          vt: r3(vt),
          vtA: r3(va.x * tx + va.z * tz),
          vtB: r3(vb.x * tx + vb.z * tz),
          spA: r3(Math.hypot(va.x, va.z)),
          spB: r3(Math.hypot(vb.x, vb.z)),
          stA: modal(stHist[0].slice(0, -1)),
          stB: modal(stHist[1].slice(0, -1)),
          stA0: sts[0],
          stB0: sts[1],
          dMin: r3(d),
          losTurn: 0,
          rMean: 0,
          hits: 0,
          speedMean: 0,
          spinLossA: 0,
          spinLossB: 0,
          _sp: 0,
          _n: 0,
          _r: 0,
          _los: Math.atan2(dz, dx),
          _s0: [A.spinRatio, B.spinRatio],
        };
      }
      if (now && cur) {
        cur.dMin = Math.min(cur.dMin, r3(d));
        const los = Math.atan2(dz, dx);
        cur.losTurn += wrap(los - cur._los);
        cur._los = los;
        cur._sp += (Math.hypot(va.x, va.z) + Math.hypot(vb.x, vb.z)) / 2;
        cur._r += (Math.hypot(pa.x, pa.z) + Math.hypot(pb.x, pb.z)) / 2;
        cur._n++;
      }
      if (!now && touching && cur) {
        const { _sp, _n, _r, _los, _s0, ...rest } = cur;
        void _los;
        contacts.push({
          ...rest,
          t1: r3(t),
          losTurn: r3(rest.losTurn),
          speedMean: r3(_sp / Math.max(1, _n)),
          rMean: r3(_r / Math.max(1, _n)),
          spinLossA: r3(_s0[0] - A.spinRatio),
          spinLossB: r3(_s0[1] - B.spinRatio),
        });
        cur = null;
        lastContactEnd = t;
      }
      touching = now;
      if (steps % FRAME_STRIDE === 0) {
        const f: number[] = [r3(t), r3(d), now ? 1 : 0];
        for (let i = 0; i < 2; i++) {
          const b = beys[i];
          const p = b.body.translation();
          const u = b.up();
          const v = b.body.linvel();
          f.push(r3(p.x), r3(p.y), r3(p.z), r3(u.x), r3(u.y), r3(u.z), Math.round(b.spin * 10) / 10, r3(b.spinRatio), r3(v.x), r3(v.z), r3(wrap(prec(b))), Math.max(0, STATES.indexOf(sts[i])), (b.dashing ? 1 : 0) | (wallNow[i] ? 2 : 0));
        }
        frames.push(f);
      }
    }
    if (cur) {
      const { _sp, _n, _r, _los, _s0, ...rest } = cur;
      void _los;
      contacts.push({ ...rest, t1: r3(steps * PHYSICS_DT), losTurn: r3(rest.losTurn), speedMean: r3(_sp / Math.max(1, _n)), rMean: r3(_r / Math.max(1, _n)), spinLossA: r3(_s0[0] - A.spinRatio), spinLossB: r3(_s0[1] - B.spinRatio) });
    }
    const res = battle.result;
    const out: Replay = {
      version,
      scenario: sc,
      dt: PHYSICS_DT * FRAME_STRIDE,
      frames,
      spinSign: [A.spinDirection, B.spinDirection] as [number, number],
      bladeR: [A.spec.blade.radius, B.spec.blade.radius],
      outerR: [A.spec.outerRadius, B.spec.outerRadius],
      contactR,
      impacts,
      contacts,
      walls,
      result: res ? `${res.winner}:${res.finish}` : 'timeout',
      duration: battle.time,
      hits: battle.hits,
      strong: battle.impacts.filter((e) => e.tier !== 'light').length,
    };
    pw.dispose();
    return out;
  } finally {
    Math.random = orig;
  }
}
