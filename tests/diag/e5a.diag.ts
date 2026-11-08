/**
 * E5-A：针尖对针尖确认僵持中的独立进动方向偏置诊断实验（必须用 vitest.e5a.config.ts 运行，该配置在测试时注入钩子，src/ 文件不改）。
 *
 * 唯一实验变量：偏置强度 b ∈ {0, 0.3, 0.6}。
 * 每个物理步、每台陀螺在 preStep 内自然进动转速算完之后（原 steering 调制块之后、launch 分支之前）：
 *   targetDirection = (对手位置 − 自身位置) 的 XZ 分量归一化
 *   自然牵引方向   = (−sin(precession)·spinSign, cos(precession)·spinSign)   ← BeyPhysics.ts 第 452–453 行，
 *                    与第 528 行 psi = precession + spinSign·π/2 的方向 (cos psi, sin psi) 逐步核对相等
 *   cosΔ          = 自然牵引方向 · targetDirection
 *   rate'         = rate · (1 − b·cosΔ)        仅当 确认僵持 且 breakout ≤ 0 且 b > 0；否则 rate' = rate（原值原样返回）
 *
 * 确认僵持（与 E5 前置核查 e5authority.diag.ts 逐字同口径；每步在 BattleSystem.preStep 之前用上一步状态判定）：
 *   双方针尖（gearGrip < 0.2）、miss > 6、双方水平速度 < 0.4、双方 spinRatio ≥ 0.4、双方 breakout ≤ 0、wobbleFor = 0，持续 ≥ 3 s。
 *
 * 只读插桩：e1e2.shared.ts 的 instrument（冲量原样转发、读取 Rapier 法向冲量与地面法线、按 E1 方法推断摩擦）。
 *
 *   E5A_B=0,0.3,0.6   要跑的 b（默认三组）
 *   E5A_OUT=目录      默认 test-results/e5a
 *   E5A_NN=1          只跑 24 场针尖对针尖（快速检查；正式隔离证明必须全 180 场）
 *   E5A_ONLY=正则      只跑名字匹配的场景（调试）
 *   E5A_SPIN_THR=值   异常转速损失阈值（rad/s / 1 s）；不给则从 <OUT>/b0/summary.json 读取 b=0 的基准 × 2
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { test } from 'vitest';
import { BEY_TUNING, type BeyPhysics } from '../../src/game/beys/BeyPhysics';
import { loadRapier, PHYSICS_DT } from '../../src/game/physics/PhysicsWorld';
import { seeded } from '../motion/motionSim';
import { instrument } from './e1e2.shared';
import { fingerprint, scenariosV2, setup } from './stallprobe2.shared';

/** 预先固定的安全停止条件（只在本场已经施加过偏置后生效；不作为优化目标，触发后停止该场并保留轨迹） */
export const SAFETY = {
  /** 异常倾角（rad）：E1 窗口实际轴倾角 P90 0.034，取约 15 倍 */
  tilt: 0.5,
  /** 贴近墙边半径（m）：0.8 × 场地半径 5.4 */
  wallR: 4.32,
  /** 异常墙边加速：贴近墙边、水平速度 > wallSpeed，且 ≥ 1 s 无几何接触或冲量响应 */
  wallSpeed: 2.0,
  wallQuietSteps: 120,
  /** 异常转速损失：最近 1 s 转速下降 > b=0 确认僵持中 1 s 下降最大值 × spinFactor */
  spinFactor: 2,
  /** 归因窗口：只在偏置施加中（b=0 组为门控开启中）及其结束后 attribSteps 步内检查，避免把对局末段自然倒转误判为偏置造成 */
  attribSteps: 120,
};

type Bey = BeyPhysics & { precession: number; spinSign: number; knockResyncs: number };
interface Rec {
  called: number;
  on: number;
  gateOn: number;
  cosD: number;
  rIn: number;
  rOut: number;
  steer: number;
  tx: number;
  tz: number;
}
const newRec = (): Rec => ({ called: 0, on: 0, gateOn: 0, cosD: NaN, rIn: NaN, rOut: NaN, steer: 0, tx: NaN, tz: NaN });

interface Ctx {
  b: number;
  confirmed: boolean;
  beys: Bey[];
  rec: [Rec, Rec];
  st: { hookCalls: number; natMismatch: number; psiMismatch: number; biasSteps: number; steerWhileConfirmed: number };
}
let ctx: Ctx | null = null;

(globalThis as unknown as { __E5A_RATE: unknown }).__E5A_RATE = (bey: Bey, rate: number, mag: number, steering: number): number => {
  if (!ctx) return rate;
  const i = ctx.beys.indexOf(bey);
  if (i < 0) return rate;
  const R = ctx.rec[i];
  const T = BEY_TUNING;
  ctx.st.hookCalls++;
  R.called = 1;
  R.rIn = rate;
  R.steer = steering;
  const s = bey.spinSign;
  const p = bey.precession;
  // 自然进动转速（第 524 行同式）；确认僵持时 steering 应为 0，此时输入 rate 必须逐位等于自然转速
  const nat = s * -(T.precessBase + T.precessSpin / Math.max(20, mag));
  if (steering === 0 && nat !== rate) ctx.st.natMismatch++;
  if (ctx.confirmed && steering > 0) ctx.st.steerWhileConfirmed++;
  // 自然牵引方向（第 452–453 行），并与第 528 行 psi 的方向核对
  const nx = -Math.sin(p) * s;
  const nz = Math.cos(p) * s;
  const psi = p + (s * Math.PI) / 2;
  if (Math.abs(Math.cos(psi) - nx) > 1e-12 || Math.abs(Math.sin(psi) - nz) > 1e-12) ctx.st.psiMismatch++;
  const o = bey.opponent!.body.translation();
  const q = bey.body.translation();
  const dx = o.x - q.x;
  const dz = o.z - q.z;
  const l = Math.hypot(dx, dz);
  const tx = l > 1e-9 ? dx / l : 0;
  const tz = l > 1e-9 ? dz / l : 0;
  const cosD = nx * tx + nz * tz;
  R.cosD = cosD;
  R.tx = tx;
  R.tz = tz;
  R.gateOn = ctx.confirmed && bey.breakout <= 0 ? 1 : 0;
  const active = R.gateOn === 1 && ctx.b > 0 && l > 1e-9;
  R.on = active ? 1 : 0;
  if (!active) {
    R.rOut = rate;
    return rate;
  }
  ctx.st.biasSteps++;
  const out = rate * (1 - ctx.b * cosD);
  R.rOut = out;
  return out;
};

const f7 = (x: number) => (Number.isFinite(x) ? String(+x.toPrecision(7)) : '');
const BEY_COLS = ['on', 'gate', 'cosD', 'ratio', 'prec', 'upX', 'upZ', 'tilt', 'kind', 'nX', 'nZ', 'fX', 'fZ', 'px', 'pz', 'vx', 'vz', 'spin', 'tx', 'tz', 'steer'];
const KIND = { none: 0, floor: 1, mixed: 2, other: 3 } as const;

test('E5-A precession bias', async () => {
  const R = await loadRapier();
  const BS = (process.env.E5A_B ?? '0,0.3,0.6').split(',').map(Number);
  const OUT = process.env.E5A_OUT ?? 'test-results/e5a';
  const nnOnly = process.env.E5A_NN === '1';
  const only = process.env.E5A_ONLY ? new RegExp(process.env.E5A_ONLY) : null;
  for (const bVal of BS) {
    const dir = `${OUT}/b${bVal}`;
    mkdirSync(`${dir}/track`, { recursive: true });
    // 异常转速损失阈值
    let spinThr = Number(process.env.E5A_SPIN_THR ?? NaN);
    if (bVal > 0 && !Number.isFinite(spinThr)) {
      const p0 = `${OUT}/b0/summary.json`;
      if (!existsSync(p0)) throw new Error('b>0 需要先跑 b=0（或给 E5A_SPIN_THR）');
      spinThr = JSON.parse(readFileSync(p0, 'utf8')).spinDrop1sMaxConfirmed * SAFETY.spinFactor;
    }
    const runs: unknown[] = [];
    let spinDropMax = 0;
    for (const sc of scenariosV2()) {
      if (only && !only.test(sc.name)) continue;
      const orig = Math.random;
      Math.random = seeded(sc.seed);
      try {
        const { pw, b, A, B } = setup(R, sc);
        const beys = [A, B] as Bey[];
        const nn = beys.every((x) => x.spec.tip.gearGrip < 0.2);
        if (nnOnly && !nn) {
          pw.dispose();
          continue;
        }
        const c: Ctx = { b: bVal, confirmed: false, beys, rec: [newRec(), newRec()], st: { hookCalls: 0, natMismatch: 0, psiMismatch: 0, biasSteps: 0, steerWhileConfirmed: 0 } };
        ctx = c;
        const ins = nn ? instrument(R, pw, b, [A, B], true) : null;
        // 确认僵持门控（e5authority.diag.ts 同式），附带退出原因
        let miss = 99;
        let dwell = 0;
        let fail = '';
        const before = pw.beforeStep!;
        pw.beforeStep = (dt) => {
          const k = b.contactClass;
          miss = k.geometric || k.impulseResponse ? 0 : miss + 1;
          const why: string[] = [];
          if (!nn) why.push('notNN');
          if (miss <= 6) why.push('contact');
          for (const x of beys) {
            const v = x.body.linvel();
            if (Math.hypot(v.x, v.z) >= 0.4) why.push('speed');
            if (x.spinRatio < 0.4) why.push('spinRatio');
            if (x.breakout > 0) why.push('breakout');
          }
          if (b.wobbleFor !== 0) why.push('wobble');
          const ok = why.length === 0;
          fail = [...new Set(why)].join('+');
          dwell = ok ? dwell + dt : 0;
          c.confirmed = dwell >= 3;
          c.rec = [newRec(), newRec()];
          before(dt);
        };
        const h = createHash('sha256');
        const max = (sc.maxSeconds ?? 60) / PHYSICS_DT;
        const rows: string[] = [];
        if (nn) rows.push(['s', 'conf', 'miss', ...[0, 1].flatMap((i) => BEY_COLS.map((k) => `${k}${i}`))].join(','));
        const spinHist: number[][] = [[], []];
        const segs: { start: number; end: number; exit: string }[] = [];
        let segStart = -1;
        let biasEver = false;
        let lastGate = -1e9;
        let stop: string | null = null;
        const safety = { maxTilt: [0, 0], maxR: [0, 0], wallSteps: [0, 0], tiltOver11Steps: [0, 0], maxSpeed: [0, 0], flagCount: 0, flags: [] as string[] };
        let s = 0;
        for (; s < max && !b.result; s++) {
          pw.step();
          fingerprint(h, beys);
          if (!nn) continue;
          // 门控段
          if (c.confirmed && segStart < 0) segStart = s;
          if (!c.confirmed && segStart >= 0) {
            segs.push({ start: segStart, end: s, exit: fail });
            segStart = -1;
          }
          if (c.rec.some((r) => r.on)) biasEver = true;
          if (c.rec.some((r) => (bVal > 0 ? r.on : r.gateOn))) lastGate = s;
          const attrib = s - lastGate <= SAFETY.attribSteps;
          const cols: string[] = [String(s), c.confirmed ? '1' : '0', String(miss)];
          beys.forEach((x, i) => {
            const r = c.rec[i];
            const L = ins!.led[i];
            const up = x.up();
            const p = x.body.translation();
            const v = x.body.linvel();
            const rr = Math.hypot(p.x, p.z);
            const sp = Math.hypot(v.x, v.z);
            cols.push(
              String(r.on),
              String(r.gateOn),
              f7(r.cosD),
              f7(r.rOut / r.rIn),
              f7(x.precession),
              f7(up.x),
              f7(up.z),
              f7(x.tilt),
              String(KIND[L.kind]),
              L.lamFloor > 0 ? f7(L.floorN.x) : '',
              L.lamFloor > 0 ? f7(L.floorN.z) : '',
              f7(L.fric.x),
              f7(L.fric.z),
              f7(p.x),
              f7(p.z),
              f7(v.x),
              f7(v.z),
              f7(x.spin),
              f7(r.tx),
              f7(r.tz),
              f7(r.steer),
            );
            safety.maxTilt[i] = Math.max(safety.maxTilt[i], x.tilt);
            safety.maxR[i] = Math.max(safety.maxR[i], rr);
            safety.maxSpeed[i] = Math.max(safety.maxSpeed[i], sp);
            if (rr >= SAFETY.wallR) safety.wallSteps[i]++;
            if (x.tilt > 1.1) safety.tiltOver11Steps[i]++;
            const hs = spinHist[i];
            hs.push(x.spin);
            if (hs.length > 121) hs.shift();
            const drop1s = hs.length > 120 ? hs[0] - hs[hs.length - 1] : 0;
            if (c.confirmed && bVal === 0) spinDropMax = Math.max(spinDropMax, drop1s);
            const flag = (why: string) => {
              const m = `${why}@${s}:bey${i}`;
              safety.flagCount++;
              if (safety.flags.length < 20) safety.flags.push(m);
              if (bVal > 0 && !stop) stop = m;
            };
            if (attrib && x.tilt > SAFETY.tilt) flag(`tilt ${x.tilt.toFixed(3)}`);
            if (attrib && rr >= SAFETY.wallR && sp > SAFETY.wallSpeed && miss > SAFETY.wallQuietSteps) flag(`wallAccel v=${sp.toFixed(2)} r=${rr.toFixed(2)}`);
            if (bVal > 0 && r.on && drop1s > spinThr) flag(`spinLoss ${drop1s.toFixed(2)}/s`);
          });
          rows.push(cols.join(','));
          if (stop) {
            s++;
            break;
          }
        }
        if (segStart >= 0) segs.push({ start: segStart, end: s, exit: b.result ? 'matchEnd' : stop ? 'safetyStop' : 'timeout' });
        const hash = h.digest('hex');
        const fname = sc.name.replace(/[^\w.-]+/g, '_');
        if (nn) writeFileSync(`${dir}/track/${fname}.csv.gz`, gzipSync(rows.join('\n')));
        runs.push({
          name: sc.name,
          group: sc.group,
          nn,
          b: bVal,
          hash,
          steps: s,
          result: b.result ? `${b.result.winner}:${b.result.finish}` : stop ? 'safetyStop' : 'timeout',
          stop,
          biasEver,
          ...c.st,
          segments: segs,
          knockResyncs: beys.map((x) => x.knockResyncs),
          breakouts: b.breakouts,
          wobbleBreaks: b.wobbleBreaks,
          safety: nn ? safety : undefined,
          spinSign: beys.map((x) => x.spinSign),
          inertia: nn ? beys.map((x) => x.body.principalInertia().y) : undefined,
          mass: nn ? beys.map((x) => x.body.mass()) : undefined,
        });
        pw.dispose();
      } finally {
        ctx = null;
        Math.random = orig;
      }
    }
    writeFileSync(`${dir}/summary.json`, JSON.stringify({ b: bVal, safetyRules: SAFETY, spinThr: bVal > 0 ? spinThr : null, spinDrop1sMaxConfirmed: bVal === 0 ? spinDropMax : null, runs }, null, 1));
  }
}, 7_200_000);
