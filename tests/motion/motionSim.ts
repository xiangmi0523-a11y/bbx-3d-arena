/**
 * 自主运动诊断（真实物理，无头，固定种子）。
 *
 * 只用基线 0dac2ad 与新版本都有的公开接口（body / spin / dashing / spec / battle.*），
 * 同一份文件可以原样拷到基线工作树里运行，做逐场对比。
 * 进动相位在基线里是私有字段 precession，这里按名字读写（两版同名）。
 *
 * 每个物理步（120 Hz）采样一次，统计：
 *  - 轨迹 / 水平速度 / 速度方向变化率 / 直线段占比；
 *  - 运动方向与“指向对手”方向的夹角 → 正面追击、环绕、远离的时间占比；
 *  - 双方距离、接触段（次数、时长、最长）、脱离与重新接近次数；
 *  - 每次接触开始时的切入角（相对速度与连心线的夹角）、接触前后运动方向的变化；
 *  - 进动相位变化率、脱困次数、贴边 / 轨道冲刺时间、出界；
 *  - 剩余转速比例、胜负。
 */
import { createArenaPhysics } from '../../src/game/arena/ArenaPhysics';
import { ARENA } from '../../src/game/arena/arenaSpec';
import { BattleSystem } from '../../src/game/battle/BattleSystem';
import type { BeyPhysics } from '../../src/game/beys/BeyPhysics';
import { assembleBey } from '../../src/game/beys/parts/assemble';
import type { BeyLoadout } from '../../src/game/beys/parts/types';
import type { LaunchCommand } from '../../src/game/launcher/PullStringGesture';
import { loadRapier, PhysicsWorld, PHYSICS_DT } from '../../src/game/physics/PhysicsWorld';

export function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface MotionScenario {
  name: string;
  player: BeyLoadout;
  rival: BeyLoadout;
  pCmd: LaunchCommand;
  rCmd: LaunchCommand;
  seed: number;
  /** 指定两台的初始进动相位（弧度）；省略则由种子决定 */
  phase?: [number, number];
  maxSeconds?: number;
  /** 记录降采样轨迹（20 Hz） */
  trace?: boolean;
}

export interface SideStats {
  meanSpeed: number;
  /** 移动时（> 0.5 m/s）速度方向变化率的平均值 rad/s */
  turnRate: number;
  /** 移动时几乎走直线（|转向率| < 0.6 rad/s）的时间占比 */
  straightFrac: number;
  /** 未接触且移动时，速度方向与指向对手方向夹角余弦的平均值（1 = 一直正对对手冲） */
  pursuitCos: number;
  /** 正面追击（cos > 0.85）、环绕（|cos| < 0.4 且距离 < 3.5 m）、远离（cos < -0.5）占移动时间的比例 */
  chaseFrac: number;
  orbitFrac: number;
  awayFrac: number;
  /** 最长一段连续正面追击（秒） */
  longestChase: number;
  /** 进动相位变化率（rad/s，绝对值平均）与其标准差 */
  precRate: number;
  precRateStd: number;
  /** 离中心平均距离、贴边（外沿距墙 < 0.4）时间占比、轨道冲刺时间占比 */
  meanR: number;
  edgeFrac: number;
  dashFrac: number;
  /** 运动方向·指向对手 cos 的分布（5 档，−1…1） */
  cosHist: number[];
  /** 运动状态时间占比（基线：charge / backoff / recoil / breakout；新版本：战术意图状态名） */
  states: Record<string, number>;
  /** 状态切换次数 /10s */
  switches10: number;
  /** 未接触时水平加速度（牵引 + 坡面 + 阻力）方向与指向对手方向的夹角余弦平均值，以及 > 0.8 的占比 */
  accelCos: number;
  accelLock: number;
  /** 未接触时 0.25 s 内运动方向反转（> 120°）的次数 /10s（急停折返） */
  cusps10: number;
  /** 被撞歪后进动相位跟随实际倾斜的次数 /10s（基线没有此机制，为 NaN） */
  knock10: number;
  /** 对局结束时的转速比例 */
  spinEnd: number;
  /** 10 秒时的转速比例（对局不足 10 秒则取结束时） */
  spin10: number;
}

export interface MotionRun {
  name: string;
  seed: number;
  duration: number;
  result: string;
  winner: string;
  finish: string;
  hits: number;
  strong: number;
  grinds: number;
  breakouts: number;
  /** 双方距离（中心距）平均值与标准差 */
  distMean: number;
  distStd: number;
  /** 接触段 */
  contacts: number;
  contactFrac: number;
  longestContact: number;
  meanContact: number;
  /** 接触后拉开到外沿间距 > 0.6 m 的次数，以及之后再次接触的次数 */
  separations: number;
  reengages: number;
  /** 拉开后重新接触的平均用时（秒） */
  reengageTime: number;
  /** 两次接触之间最长的间隔（秒） */
  longestGap: number;
  /** 接触开始时相对速度与连心线的夹角（度），中位数；斜切（> 30°）占比 */
  cutAngleMedian: number;
  obliqueFrac: number;
  /** 接触开始时的法向接近速度中位数（m/s） */
  approachMedian: number;
  /** 接触前 0.1 s 与接触结束后 0.3 s 的运动方向变化（度），双方平均 */
  postTurn: number;
  /** 接触结束后 0.3 s 的平均水平速度 */
  postSpeed: number;
  /** 每次再接触前，上一次接触后外沿间距的最大值（m）中位数；未真正拉开（< 0.6 m）就再撞上的比例（顶牛） */
  gapMedian: number;
  rebuttFrac: number;
  /** 近距离（< 3.5 m）未接触时，相对速度中切向分量占比的平均值（0 = 沿连心线直来直去，1 = 纯环绕） */
  relTangential: number;
  /** 连心线方向累计转过的角度（rad /10s）：两台互相环绕的程度 */
  losTurn10: number;
  /** 撞墙次数（刀刃 / 盘 / 轴碰到外墙的接触开始，双方合计）/10s */
  wall10: number;
  /** 撞墙时所处的运动状态 */
  wallStates: Record<string, number>;
  /** 系统总机械能（平动 + 自转 + 重力势能）相对发射后 0.5 s 的最大比值（> 1 说明有能量凭空增加） */
  energyMaxRatio: number;
  p: SideStats;
  r: SideStats;
  trace?: number[][];
}

const median = (a: number[]) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

interface SideAcc {
  speed: number;
  moving: number;
  turn: number;
  straight: number;
  cosSum: number;
  cosN: number;
  chase: number;
  orbit: number;
  away: number;
  curChase: number;
  longestChase: number;
  prec: number[];
  rSum: number;
  edge: number;
  dash: number;
  lastHeading: number;
  lastPrec: number;
  spin10: number;
  hist: number[];
  acSum: number;
  acN: number;
  acLock: number;
  lastV: [number, number] | null;
  hBuf: number[];
  cusps: number;
  cuspCool: number;
  states: Record<string, number>;
  lastState: string;
  switches: number;
}

const newAcc = (): SideAcc => ({
  speed: 0,
  moving: 0,
  turn: 0,
  straight: 0,
  cosSum: 0,
  cosN: 0,
  chase: 0,
  orbit: 0,
  away: 0,
  curChase: 0,
  longestChase: 0,
  prec: [],
  rSum: 0,
  edge: 0,
  dash: 0,
  lastHeading: NaN,
  lastPrec: NaN,
  spin10: NaN,
  hist: [0, 0, 0, 0, 0],
  acSum: 0,
  acN: 0,
  acLock: 0,
  lastV: null,
  hBuf: [],
  cusps: 0,
  cuspCool: 0,
  states: {},
  lastState: '',
  switches: 0,
});

/** 当前运动状态：新版本读 intentState，基线由 charging / recoil / breakout 字段推出 */
function stateOf(b: BeyPhysics): string {
  const x = b as unknown as { intentState?: string; charging?: boolean; recoil?: number; breakout?: number };
  if (typeof x.intentState === 'string') return x.intentState;
  if ((x.breakout ?? 0) > 0) return 'breakout';
  if ((x.recoil ?? 0) > 0) return 'recoil';
  return x.charging ? 'charge' : 'backoff';
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

function precOf(b: BeyPhysics): number {
  return (b as unknown as { precession: number }).precession;
}

export async function runMotion(sc: MotionScenario): Promise<MotionRun> {
  const orig = Math.random;
  Math.random = seeded(sc.seed);
  try {
    const R = await loadRapier();
    const pw = new PhysicsWorld(R);
    const arena = createArenaPhysics(pw);
    const wallSet = new Set(arena.walls.map((c) => c.handle));
    const onWall = [false, false];
    let wallHits = 0;
    const wallStates: Record<string, number> = {};
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
    const acc = [newAcc(), newAcc()];
    const contactR = A.spec.blade.radius + B.spec.blade.radius + 0.03;
    const sepR = A.spec.outerRadius + B.spec.outerRadius + 0.6;
    const max = (sc.maxSeconds ?? 60) / PHYSICS_DT;
    const headings: number[][] = [[], []];
    const speeds: number[][] = [[], []];
    let distSum = 0;
    let distSq = 0;
    let steps = 0;
    let touching = false;
    let contacts = 0;
    let contactSteps = 0;
    let cur = 0;
    let longest = 0;
    const durations: number[] = [];
    let separated = true; // 发射时视为已拉开
    let sepStart = 0;
    let everContact = false;
    let separations = 0;
    let reengages = 0;
    const reengageTimes: number[] = [];
    let lastContactEnd = 0;
    let longestGap = 0;
    const cutAngles: number[] = [];
    const approaches: number[] = [];
    const pending: { endStep: number; before: [number, number] }[] = [];
    const postTurns: number[] = [];
    const postSpeeds: number[] = [];
    let contactStartHeading: [number, number] = [NaN, NaN];
    let gapMax = 0;
    const gaps: number[] = [];
    let tanSum = 0;
    let tanN = 0;
    let losTurn = 0;
    let lastLos = NaN;
    let e0 = NaN;
    let eMax = 0;
    const trace: number[][] = [];
    const energy = () => {
      let e = 0;
      for (const b of beys) {
        const v = b.body.linvel();
        const m = b.body.mass();
        const p = b.body.translation();
        e += 0.5 * m * (v.x * v.x + v.y * v.y + v.z * v.z) + 0.5 * b.spec.spinInertia * b.spin * b.spin + m * 20 * p.y;
      }
      return e;
    };

    for (; steps < max && !battle.result; steps++) {
      pw.step();
      const t = (steps + 1) * PHYSICS_DT;
      const pa = A.body.translation();
      const pb = B.body.translation();
      const dx = pb.x - pa.x;
      const dz = pb.z - pa.z;
      const d = Math.hypot(dx, dz);
      distSum += d;
      distSq += d * d;
      for (let i = 0; i < 2; i++) {
        let tw = false;
        for (const c of beys[i].colliders) {
          pw.world.contactPairsWith(c, (o) => {
            if (wallSet.has(o.handle)) tw = true;
          });
        }
        if (tw && !onWall[i]) {
          wallHits++;
          const st = stateOf(beys[i]) + (beys[i].dashing ? '+dash' : '');
          wallStates[st] = (wallStates[st] ?? 0) + 1;
        }
        onWall[i] = tw;
      }
      for (let i = 0; i < 2; i++) {
        const b = beys[i];
        const o = beys[1 - i];
        const a = acc[i];
        const p = b.body.translation();
        const op = o.body.translation();
        const v = b.body.linvel();
        const sp = Math.hypot(v.x, v.z);
        a.speed += sp;
        const r = Math.hypot(p.x, p.z);
        a.rSum += r;
        if (r + b.spec.outerRadius > ARENA.radius - 0.4) a.edge++;
        if (b.dashing) a.dash++;
        const st = stateOf(b);
        a.states[st] = (a.states[st] ?? 0) + 1;
        if (st !== a.lastState) {
          if (a.lastState) a.switches++;
          a.lastState = st;
        }
        const h = Math.atan2(v.z, v.x);
        headings[i].push(sp > 0.3 ? h : NaN);
        speeds[i].push(sp);
        const pr = precOf(b);
        if (Number.isFinite(a.lastPrec)) a.prec.push(Math.abs(wrap(pr - a.lastPrec)) / PHYSICS_DT);
        a.lastPrec = pr;
        {
          const farEnough = d > contactR + 0.1;
          if (a.lastV && farEnough) {
            const axx = (v.x - a.lastV[0]) / PHYSICS_DT;
            const azz = (v.z - a.lastV[1]) / PHYSICS_DT;
            const al = Math.hypot(axx, azz);
            if (al > 1) {
              const ox = op.x - p.x;
              const oz = op.z - p.z;
              const c = (axx * ox + azz * oz) / (al * (Math.hypot(ox, oz) || 1));
              a.acSum += c;
              a.acN++;
              if (c > 0.8) a.acLock++;
            }
          }
          a.lastV = [v.x, v.z];
          a.hBuf.push(sp > 0.6 && farEnough ? h : NaN);
          if (a.hBuf.length > 30) a.hBuf.shift();
          if (a.cuspCool > 0) a.cuspCool--;
          else if (a.hBuf.length === 30 && Number.isFinite(a.hBuf[0]) && Number.isFinite(a.hBuf[29]) && a.hBuf.every(Number.isFinite)) {
            if (Math.abs(wrap(a.hBuf[29] - a.hBuf[0])) > (2 * Math.PI) / 3) {
              a.cusps++;
              a.cuspCool = 30;
            }
          }
        }
        if (sp > 0.5) {
          a.moving++;
          if (Number.isFinite(a.lastHeading)) {
            const tr = Math.abs(wrap(h - a.lastHeading)) / PHYSICS_DT;
            a.turn += Math.min(tr, 40);
            if (tr < 0.6) a.straight++;
          }
          a.lastHeading = h;
          const ox = op.x - p.x;
          const oz = op.z - p.z;
          const ol = Math.hypot(ox, oz) || 1;
          if (d > contactR + 0.05) {
            const c = (v.x * ox + v.z * oz) / (sp * ol);
            a.cosSum += c;
            a.cosN++;
            a.hist[Math.min(4, Math.floor((c + 1) * 2.5))]++;
            if (c > 0.85) {
              a.chase++;
              a.curChase += PHYSICS_DT;
              a.longestChase = Math.max(a.longestChase, a.curChase);
            } else a.curChase = 0;
            if (Math.abs(c) < 0.4 && d < 3.5) a.orbit++;
            if (c < -0.5) a.away++;
          } else a.curChase = 0;
        } else {
          a.lastHeading = NaN;
          a.curChase = 0;
        }
        if (Math.abs(t - 10) < PHYSICS_DT / 2) a.spin10 = b.spinRatio;
      }

      const now = d < contactR;
      const outerGap = d - A.spec.outerRadius - B.spec.outerRadius;
      if (!now) gapMax = Math.max(gapMax, outerGap);
      {
        const los = Math.atan2(dz, dx);
        if (Number.isFinite(lastLos) && d < 3.5) losTurn += Math.abs(wrap(los - lastLos));
        lastLos = los;
        const va = A.body.linvel();
        const vb = B.body.linvel();
        const rx = va.x - vb.x;
        const rz = va.z - vb.z;
        const rl = Math.hypot(rx, rz);
        if (!now && d < 3.5 && rl > 0.5) {
          const rad = Math.abs(rx * dx + rz * dz) / (d || 1);
          tanSum += Math.sqrt(Math.max(0, 1 - (rad / rl) ** 2));
          tanN++;
        }
      }
      if (now && !touching) {
        contacts++;
        if (contacts > 1) gaps.push(gapMax);
        gapMax = 0;
        everContact = true;
        if (separated && contacts > 1) {
          reengages++;
          reengageTimes.push(t - sepStart);
        }
        separated = false;
        longestGap = Math.max(longestGap, t - lastContactEnd);
        // 切入角：相对速度与连心线夹角
        const va = A.body.linvel();
        const vb = B.body.linvel();
        const rx = va.x - vb.x;
        const rz = va.z - vb.z;
        const rl = Math.hypot(rx, rz);
        if (rl > 0.3) {
          const c = (rx * dx + rz * dz) / (rl * (d || 1));
          cutAngles.push((Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI);
          approaches.push(Math.max(0, (rx * dx + rz * dz) / (d || 1)));
        }
        const k = Math.max(0, headings[0].length - 13);
        contactStartHeading = [headings[0][k], headings[1][k]];
      }
      if (now) {
        contactSteps++;
        cur += PHYSICS_DT;
        longest = Math.max(longest, cur);
      } else if (touching) {
        durations.push(cur);
        cur = 0;
        lastContactEnd = t;
        pending.push({ endStep: steps + 36, before: contactStartHeading });
      }
      touching = now;
      if (!separated && everContact && d > sepR) {
        separated = true;
        separations++;
        sepStart = t;
      }
      while (pending.length && pending[0].endStep <= steps) {
        const pe = pending.shift()!;
        for (let i = 0; i < 2; i++) {
          const h1 = headings[i][headings[i].length - 1];
          const h0 = pe.before[i];
          if (Number.isFinite(h0) && Number.isFinite(h1)) postTurns.push((Math.abs(wrap(h1 - h0)) * 180) / Math.PI);
          postSpeeds.push(speeds[i][speeds[i].length - 1]);
        }
      }
      if (t >= 0.5) {
        const e = energy();
        if (!Number.isFinite(e0)) e0 = e;
        eMax = Math.max(eMax, e / e0);
      }
      if (sc.trace && steps % 6 === 0) {
        trace.push([
          +t.toFixed(3),
          +pa.x.toFixed(3),
          +pa.z.toFixed(3),
          +pb.x.toFixed(3),
          +pb.z.toFixed(3),
          +A.spinRatio.toFixed(3),
          +B.spinRatio.toFixed(3),
          now ? 1 : 0,
        ]);
      }
    }
    if (touching) durations.push(cur);
    longestGap = Math.max(longestGap, steps * PHYSICS_DT - lastContactEnd);

    const side = (i: number): SideStats => {
      const a = acc[i];
      const b = beys[i];
      const pm = a.prec.length ? a.prec.reduce((s, v) => s + v, 0) / a.prec.length : 0;
      const pv = a.prec.length ? Math.sqrt(a.prec.reduce((s, v) => s + (v - pm) ** 2, 0) / a.prec.length) : 0;
      return {
        meanSpeed: a.speed / steps,
        turnRate: a.moving ? a.turn / a.moving : 0,
        straightFrac: a.moving ? a.straight / a.moving : 0,
        pursuitCos: a.cosN ? a.cosSum / a.cosN : 0,
        chaseFrac: a.cosN ? a.chase / a.cosN : 0,
        orbitFrac: a.cosN ? a.orbit / a.cosN : 0,
        awayFrac: a.cosN ? a.away / a.cosN : 0,
        longestChase: a.longestChase,
        precRate: pm,
        precRateStd: pv,
        meanR: a.rSum / steps,
        edgeFrac: a.edge / steps,
        dashFrac: a.dash / steps,
        cosHist: a.hist.map((h) => (a.cosN ? h / a.cosN : 0)),
        states: Object.fromEntries(Object.entries(a.states).map(([k, v]) => [k, v / steps])),
        switches10: (a.switches / (steps * PHYSICS_DT)) * 10,
        accelCos: a.acN ? a.acSum / a.acN : NaN,
        accelLock: a.acN ? a.acLock / a.acN : NaN,
        cusps10: (a.cusps / (steps * PHYSICS_DT)) * 10,
        knock10: typeof (b as unknown as { knockResyncs?: number }).knockResyncs === 'number' ? ((b as unknown as { knockResyncs: number }).knockResyncs / (steps * PHYSICS_DT)) * 10 : NaN,
        spinEnd: b.spinRatio,
        spin10: Number.isFinite(a.spin10) ? a.spin10 : b.spinRatio,
      };
    };
    const dm = distSum / steps;
    const res = battle.result;
    const out: MotionRun = {
      name: sc.name,
      seed: sc.seed,
      duration: battle.time,
      result: res ? `${res.winner}:${res.finish}` : 'timeout',
      winner: res ? (res.winner ?? 'draw') : 'none',
      finish: res ? (res.finish ?? 'draw') : 'timeout',
      hits: battle.hits,
      strong: battle.impacts.filter((e) => e.tier !== 'light').length,
      grinds: battle.grinds,
      breakouts: battle.breakouts,
      distMean: dm,
      distStd: Math.sqrt(Math.max(0, distSq / steps - dm * dm)),
      contacts,
      contactFrac: contactSteps / steps,
      longestContact: longest,
      meanContact: durations.length ? durations.reduce((s, v) => s + v, 0) / durations.length : 0,
      separations,
      reengages,
      reengageTime: reengageTimes.length ? reengageTimes.reduce((s, v) => s + v, 0) / reengageTimes.length : NaN,
      longestGap,
      cutAngleMedian: median(cutAngles),
      obliqueFrac: cutAngles.length ? cutAngles.filter((a) => a > 30).length / cutAngles.length : NaN,
      approachMedian: median(approaches),
      postTurn: postTurns.length ? postTurns.reduce((s, v) => s + v, 0) / postTurns.length : NaN,
      postSpeed: postSpeeds.length ? postSpeeds.reduce((s, v) => s + v, 0) / postSpeeds.length : NaN,
      gapMedian: median(gaps),
      rebuttFrac: gaps.length ? gaps.filter((g) => g < 0.6).length / gaps.length : NaN,
      relTangential: tanN ? tanSum / tanN : NaN,
      losTurn10: (losTurn / (steps * PHYSICS_DT)) * 10,
      wallStates,
      wall10: (wallHits / (steps * PHYSICS_DT)) * 10,
      energyMaxRatio: eMax,
      p: side(0),
      r: side(1),
    };
    if (sc.trace) out.trace = trace;
    pw.dispose();
    return out;
  } finally {
    Math.random = orig;
  }
}
