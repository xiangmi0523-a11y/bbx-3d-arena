/// <reference types="node" />
/**
 * E-A1：重击模型（产品决定 D1 方案 A）筛选——探索性，不作采用依据。规则见 docs/engineering/m5b-experiment-plan.md §3.2（本脚本只实现、不改规则）。
 *
 * 臂：base（现有咬合模型）/ claw κ = 0.05、0.1、0.2、0.3。签名矩阵 4 × 4 × 20，seed = 20000 + 1000·p + 100·r + i（与 M5a G / H / J 相同）。
 * 输出（行首 M5B-A1）：每臂的终结分布、出界 + 极限、自灭、各构筑胜率、对阵、时长、D4 掉速口径（含 claw 分项）、
 * 重击统计与物理审计（能量审计拒绝次数、最大相对 ΔKE、Rapier 实际施加后的线动量残差、最大水平速度、NaN / 穿地回合数）；
 * 最后按预注册的选臂规则给出选定的 κ（或“没有一臂进入目标带”）。
 *
 * 用法：npx vitest run --config vitest.diag.config.ts tests/diag/m5b-claw.diag.ts -t "E-A1"
 */
import { test } from 'vitest';
import { ARENA, floorHeight, pocketAtAngle } from '../../src/game/arena/arenaSpec';
import { CLAW_EXPERIMENT } from '../../src/game/battle/clawStrike';
import { loadRapier } from '../../src/game/physics/PhysicsWorld';
import { matrixScenarios, out, quantile, r2, r3, runRound, summarize, type RoundRec } from './m5b.shared';

/** 临时打开重击模型（κ），结束后恢复默认 */
export function withClaw<T>(kappa: number | null, fn: () => T): T {
  const old = { ...CLAW_EXPERIMENT };
  if (kappa !== null) {
    CLAW_EXPERIMENT.enabled = 1;
    CLAW_EXPERIMENT.kappa = kappa;
  } else CLAW_EXPERIMENT.enabled = 0;
  try {
    return fn();
  } finally {
    Object.assign(CLAW_EXPERIMENT, old);
  }
}

/** 运行一个臂：每回合结束时记录重击统计 */
export function runClawArm(R: Awaited<ReturnType<typeof loadRapier>>, kappa: number | null, base: number, seeds: number): RoundRec[] {
  const scs = matrixScenarios(base, seeds);
  return withClaw(kappa, () =>
    scs.map((sc) =>
      runRound(R, sc, undefined, (ctx, rec) => {
        const c = ctx.b.claw;
        rec.extra = { strikes: c.strikes, rejected: c.rejectedEnergy, maxDv: c.maxDv, sumDv: c.sumDv, maxRelDke: c.strikes ? c.maxRelDke : 0, momentumResid: c.momentumResid, maxSpinLoss: c.maxSpinLoss };
      }),
    ),
  );
}

/** 重击统计与物理审计汇总 */
export function clawAudit(recs: RoundRec[]) {
  const ex = recs.map((x) => x.extra ?? {});
  const strikes = ex.map((e) => e.strikes ?? 0);
  const total = strikes.reduce((a, v) => a + v, 0);
  const withStrike = ex.filter((e) => (e.strikes ?? 0) > 0);
  return {
    strikesPerRoundMean: r2(total / recs.length),
    strikesPerRoundP50: quantile(strikes, 0.5),
    dvPerStrikeMean: r2(ex.reduce((a, e) => a + (e.sumDv ?? 0), 0) / Math.max(1, total)),
    roundMaxDv: { p50: r2(quantile(withStrike.map((e) => e.maxDv ?? 0), 0.5)), p90: r2(quantile(withStrike.map((e) => e.maxDv ?? 0), 0.9)), max: r2(Math.max(0, ...withStrike.map((e) => e.maxDv ?? 0))) },
    maxSpinLossPerStrike: r2(Math.max(0, ...ex.map((e) => e.maxSpinLoss ?? 0))),
    rejectedEnergy: ex.reduce((a, e) => a + (e.rejected ?? 0), 0),
    maxRelDke: Math.max(...ex.map((e) => e.maxRelDke ?? 0)),
    momentumResidMax: Math.max(0, ...ex.map((e) => e.momentumResid ?? 0)),
    badRounds: recs.filter((x) => x.bad).length,
  };
}

test('E-A1：重击模型筛选（探索性，m5b-experiment-plan.md §3.2）', async () => {
  const R = await loadRapier();
  const arms: { arm: string; kappa: number | null }[] = [
    { arm: 'base', kappa: null },
    { arm: 'claw0.05', kappa: 0.05 },
    { arm: 'claw0.1', kappa: 0.1 },
    { arm: 'claw0.2', kappa: 0.2 },
    { arm: 'claw0.3', kappa: 0.3 },
  ];
  const rows: { arm: string; kappa: number | null; outShare: number; ownShare: number; audit: ReturnType<typeof clawAudit> }[] = [];
  for (const a of arms) {
    const t0 = Date.now();
    const recs = runClawArm(R, a.kappa, 20000, 20);
    const sum = summarize(recs);
    const audit = clawAudit(recs);
    rows.push({ arm: a.arm, kappa: a.kappa, outShare: sum.outShare, ownShare: sum.ownShare, audit });
    out(`M5B-A1 ${a.arm}`, { ms: Date.now() - t0, kappa: a.kappa, ...sum, audit });
  }
  // 预注册选臂规则：物理审计零违规、自灭 ≤ base + 5 个百分点的臂中，出界 + 极限占比最接近 20%；目标带 13–28%
  const base = rows[0];
  const eligible = rows.filter((r) => r.kappa !== null && r.audit.rejectedEnergy === 0 && r.audit.badRounds === 0 && r.audit.maxRelDke <= 1e-9 && r.ownShare <= base.ownShare + 0.05 + 1e-9);
  const inBand = eligible.filter((r) => r.outShare >= 0.13 && r.outShare <= 0.28);
  const pick = [...inBand].sort((x, y) => Math.abs(x.outShare - 0.2) - Math.abs(y.outShare - 0.2))[0] ?? null;
  out('M5B-A1 selection', {
    eligible: eligible.map((r) => ({ arm: r.arm, outShare: r.outShare, ownShare: r.ownShare })),
    excluded: rows.filter((r) => r.kappa !== null && !eligible.includes(r)).map((r) => ({ arm: r.arm, outShare: r.outShare, ownShare: r.ownShare, rejected: r.audit.rejectedEnergy, bad: r.audit.badRounds, maxRelDke: r.audit.maxRelDke })),
    inBand: inBand.map((r) => r.arm),
    selected: pick ? { arm: pick.arm, kappa: pick.kappa, outShare: pick.outShare } : null,
    note: pick ? '进入 E-A2 确认实验' : '没有一臂进入 13–28%：报告方向与原因，不进入 E-A2',
    baseOutShare: r3(base.outShare),
  });
}, 3_000_000);

// ───────────────────────────── E-A1b：κ × R6 口袋 + 重击方向测量（m5b-experiment-plan.md §3.2b） ─────────────────────────────

function withPockets<T>(w: [number, number] | null, fn: () => T): T {
  const old = ARENA.pockets.map((p) => p.width);
  if (w) for (const p of ARENA.pockets) p.width = p.kind === 'xtreme' ? w[1] : w[0];
  try {
    return fn();
  } finally {
    ARENA.pockets.forEach((p, i) => (p.width = old[i]));
  }
}

/** 每回合的重击方向统计（只读）：速度变化 ≥ 6 u/s 的一方，沿新速度方向到碗沿的交点是否在口袋扇区、速度是否足以爬出碗沿 */
function knockTracker() {
  const st = { big: 0, toPocket: 0, enough: 0, both: 0 };
  let prev: { x: number; z: number }[] | null = null;
  let strikes = 0;
  const onStep = (ctx: { b: { claw: { strikes: number } }; A: { body: { linvel(): { x: number; y: number; z: number }; translation(): { x: number; y: number; z: number } } }; B: { body: { linvel(): { x: number; y: number; z: number }; translation(): { x: number; y: number; z: number } } } }) => {
    const beys = [ctx.A, ctx.B];
    const vel = beys.map((x) => x.body.linvel());
    if (prev && ctx.b.claw.strikes > strikes) {
      const rim = floorHeight(ARENA.radius);
      for (let k = 0; k < 2; k++) {
        const v = vel[k];
        const dv = Math.hypot(v.x - prev[k].x, v.z - prev[k].z);
        if (dv < 6) continue;
        st.big++;
        const p = beys[k].body.translation();
        const a = v.x * v.x + v.z * v.z;
        const bq = 2 * (p.x * v.x + p.z * v.z);
        const c = p.x * p.x + p.z * p.z - ARENA.radius * ARENA.radius;
        const disc = bq * bq - 4 * a * c;
        if (a < 1e-9 || disc < 0) continue;
        const t = (-bq + Math.sqrt(disc)) / (2 * a);
        const hx = p.x + v.x * t;
        const hz = p.z + v.z * t;
        const toPocket = !!pocketAtAngle(Math.atan2(hz, hx));
        const r = Math.hypot(p.x, p.z);
        const enough = a >= 2 * 20 * Math.max(0, rim - floorHeight(Math.min(r, ARENA.radius)));
        if (toPocket) st.toPocket++;
        if (enough) st.enough++;
        if (toPocket && enough) st.both++;
      }
    }
    strikes = ctx.b.claw.strikes;
    prev = vel.map((v) => ({ x: v.x, z: v.z }));
  };
  return { st, onStep };
}

test('E-A1b：重击 κ × R6 口袋 + 重击方向（探索性，m5b-experiment-plan.md §3.2b）', async () => {
  const R = await loadRapier();
  const R6: [number, number] = [2.5, 3.85];
  const arms: { arm: string; kappa: number | null; pockets: [number, number] | null }[] = [
    { arm: 'base', kappa: null, pockets: null },
    { arm: 'base+R6', kappa: null, pockets: R6 },
    { arm: 'claw0.05', kappa: 0.05, pockets: null },
    { arm: 'claw0.05+R6', kappa: 0.05, pockets: R6 },
    { arm: 'claw0.1', kappa: 0.1, pockets: null },
    { arm: 'claw0.1+R6', kappa: 0.1, pockets: R6 },
    { arm: 'claw0.2', kappa: 0.2, pockets: null },
    { arm: 'claw0.2+R6', kappa: 0.2, pockets: R6 },
  ];
  const rows: { arm: string; kappa: number | null; r6: boolean; outShare: number; ownShare: number; maxSpeed: number; audit: ReturnType<typeof clawAudit> }[] = [];
  for (const a of arms) {
    const t0 = Date.now();
    const knock = { big: 0, toPocket: 0, enough: 0, both: 0 };
    const recs = withPockets(a.pockets, () =>
      withClaw(a.kappa, () =>
        matrixScenarios(20000, 20).map((sc) => {
          const kt = knockTracker();
          return runRound(R, sc, kt.onStep, (ctx, rec) => {
            const c = ctx.b.claw;
            rec.extra = { strikes: c.strikes, rejected: c.rejectedEnergy, maxDv: c.maxDv, sumDv: c.sumDv, maxRelDke: c.strikes ? c.maxRelDke : 0, momentumResid: c.momentumResid, maxSpinLoss: c.maxSpinLoss };
            knock.big += kt.st.big;
            knock.toPocket += kt.st.toPocket;
            knock.enough += kt.st.enough;
            knock.both += kt.st.both;
          });
        }),
      ),
    );
    const sum = summarize(recs);
    const audit = clawAudit(recs);
    rows.push({ arm: a.arm, kappa: a.kappa, r6: !!a.pockets, outShare: sum.outShare, ownShare: sum.ownShare, maxSpeed: sum.maxSpeed, audit });
    const k = knock.big || 1;
    out(`M5B-A1b ${a.arm}`, {
      ms: Date.now() - t0,
      kappa: a.kappa,
      pockets: a.pockets ?? 'base',
      ...sum,
      audit,
      bigKnocks: { perRound: r2(knock.big / recs.length), toPocketPct: r2((knock.toPocket / k) * 100), enoughSpeedPct: r2((knock.enough / k) * 100), bothPct: r2((knock.both / k) * 100) },
    });
  }
  // 预注册选臂规则（§3.2b）：审计零违规、最大水平速度 ≤ 25、自灭 ≤ 同口袋旧模型臂 + 5 个百分点；出界 + 极限在 13–28% 内且最接近 20%
  const ref = (r6: boolean) => rows.find((x) => x.kappa === null && x.r6 === r6)!;
  const eligible = rows.filter((r) => r.kappa !== null && r.audit.rejectedEnergy === 0 && r.audit.badRounds === 0 && r.audit.maxRelDke <= 1e-9 && r.maxSpeed <= 25 && r.ownShare <= ref(r.r6).ownShare + 0.05 + 1e-9);
  const inBand = eligible.filter((r) => r.outShare >= 0.13 && r.outShare <= 0.28);
  const pick = [...inBand].sort((x, y) => Math.abs(x.outShare - 0.2) - Math.abs(y.outShare - 0.2))[0] ?? null;
  out('M5B-A1b selection', {
    rows: rows.map((r) => ({ arm: r.arm, outShare: r.outShare, ownShare: r.ownShare, maxSpeed: r.maxSpeed })),
    eligible: eligible.map((r) => r.arm),
    inBand: inBand.map((r) => r.arm),
    selected: pick ? { arm: pick.arm, kappa: pick.kappa, r6: pick.r6, outShare: pick.outShare } : null,
    note: pick ? '进入 E-A2 确认实验' : '没有一臂进入 13–28%：结论为击飞需要 AI 主动把对手撞向口袋（M4），不再加大 κ 或改竞技场几何',
  });
}, 3_000_000);
