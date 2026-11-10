/// <reference types="node" />
/**
 * M5a 掉速账本（v2.0 S1 任务 1.3 / E7）：v2.0 签名矩阵上，每一方每回合的转速变化按来源分解。
 * 只读：账本与物理计算并行累加（BeyPhysics.ledger），不改变任何物理量。
 *
 * 输出（行首 M5-E）：每个签名构筑（非镜像）的平均分项（rad/s / 回合，及占发射转速的比例）、胜负两侧对比、
 * 默认对局 森衡 对 磐盾 的明细；以及账本闭合检查：发射转速 − 终局转速 与 Σ损失 − Σ增益 的残差（E7 验收：< 5%）。
 *
 * 用法：npx vitest run --config vitest.diag.config.ts tests/diag/m5-balance.diag.ts（M5_SEEDS 每个对阵的种子数，默认 20）
 */
import { test } from 'vitest';
import { ARENA_PHYSICS } from '../../src/game/arena/ArenaPhysics';
import { ARENA } from '../../src/game/arena/arenaSpec';
import type { SpinLedger } from '../../src/game/beys/BeyPhysics';
import { SIGNATURE_LIST } from '../../src/game/beys/parts/catalog';
import { rivalCommand } from '../../src/game/launcher/launch';
import { loadRapier, PHYSICS_DT } from '../../src/game/physics/PhysicsWorld';
import { seeded } from '../motion/motionSim';
import { setup, type R as RT, type Scn } from './stallprobe2.shared';

const out = (tag: string, v: unknown) => process.stdout.write(`${tag} ${JSON.stringify(v)}\n`);
const SEEDS = Number(process.env.M5_SEEDS ?? 20);
const r2 = (v: number) => Math.round(v * 100) / 100;
const KEYS: (keyof SpinLedger)[] = ['base', 'air', 'drive', 'steer', 'rail', 'scrape', 'smash', 'contactLoss', 'contactGain', 'burst'];

interface Side {
  key: string;
  launch: number;
  end: number;
  ledger: SpinLedger;
  won: boolean | null;
}

test('E：签名矩阵上的掉速账本', async () => {
  const R: RT = await loadRapier();
  const POW = [0.65, 0.8, 0.95];
  const rows: { p: Side; r: Side; dur: number; finish: string | null }[] = [];
  SIGNATURE_LIST.forEach((p, pi) =>
    SIGNATURE_LIST.forEach((r, ri) => {
      for (let i = 0; i < SEEDS; i++) {
        const seed = 20000 + pi * 1000 + ri * 100 + i;
        const rnd = seeded(seed * 7 + 13);
        const sc: Scn = { name: `${p.key}-${r.key}#${i}`, group: 'SIG', player: p.loadout, rival: r.loadout, pCmd: { power: POW[i % 3], aim: (rnd() - 0.5) * 1.2, tilt: 0 }, rCmd: rivalCommand(rnd), seed, maxSeconds: 61, init: '签名矩阵' };
        const orig = Math.random;
        Math.random = seeded(sc.seed);
        try {
          const { pw, b, A, B } = setup(R, sc, { observeContacts: true });
          const max = Math.round(61 / PHYSICS_DT);
          for (let s = 0; s < max && !b.result; s++) pw.step();
          const o = b.judgeRound.outcome;
          const won = (side: 'player' | 'rival') => (o && o.kind === 'win' ? o.winner === side : null);
          rows.push({
            p: { key: p.key, launch: A.launchSpin, end: A.spin, ledger: { ...A.ledger }, won: won('player') },
            r: { key: r.key, launch: B.launchSpin, end: B.spin, ledger: { ...B.ledger }, won: won('rival') },
            dur: o?.time ?? b.time,
            finish: o?.finish ?? o?.kind ?? null,
          });
          pw.dispose();
        } finally {
          Math.random = orig;
        }
      }
    }),
  );
  // 账本闭合：发射转速 − 终局转速 = Σ损失 − Σ增益（残差相对发射转速）
  const resid: number[] = [];
  for (const x of rows)
    for (const s of [x.p, x.r]) {
      const L = s.ledger;
      const loss = L.base + L.air + L.drive + L.steer + L.rail + L.scrape + L.smash + L.contactLoss + L.burst - L.contactGain;
      resid.push(Math.abs(s.launch - s.end - loss) / s.launch);
    }
  resid.sort((a, b) => a - b);
  const summarize = (sides: Side[]) => {
    const n = sides.length || 1;
    const avg: Record<string, number> = {};
    for (const k of KEYS) avg[k] = r2(sides.reduce((a, s) => a + s.ledger[k], 0) / n);
    const launch = sides.reduce((a, s) => a + s.launch, 0) / n;
    const share: Record<string, number> = {};
    for (const k of KEYS) share[k] = r2((avg[k] / launch) * 100);
    return { n: sides.length, launch: r2(launch), end: r2(sides.reduce((a, s) => a + s.end, 0) / n), avg, sharePct: share };
  };
  const nonMirror = rows.filter((x) => x.p.key !== x.r.key);
  const perSig: Record<string, unknown> = {};
  for (const sg of SIGNATURE_LIST) {
    const sides = nonMirror.flatMap((x) => [x.p, x.r]).filter((s) => s.key === sg.key);
    perSig[sg.key] = { all: summarize(sides), won: summarize(sides.filter((s) => s.won === true)), lost: summarize(sides.filter((s) => s.won === false)) };
  }
  const dflt = rows.filter((x) => x.p.key === 'senheng' && x.r.key === 'pandun');
  out('M5-E ledger', {
    rounds: rows.length,
    residualP50: resid[Math.floor(resid.length / 2)],
    residualP99: resid[Math.floor(resid.length * 0.99)],
    residualMax: resid[resid.length - 1],
    durationP50: r2([...rows.map((x) => x.dur)].sort((a, b) => a - b)[Math.floor(rows.length / 2)]),
    perSignature: perSig,
    defaultSenhengVsPandun: { senheng: summarize(dflt.map((x) => x.p)), pandun: summarize(dflt.map((x) => x.r)), finishes: dflt.map((x) => `${x.p.won ? 'P' : x.r.won ? 'R' : '='}:${x.finish}:${r2(x.dur)}`) },
  });
}, 1_800_000);

// ───────────────────────────── F. 竞技场 A/B：口袋宽度（R6）与墙恢复系数（R7） ─────────────────────────────
/**
 * v2.0 §6.7 预注册规则：
 *  R6 口袋加宽（出界 1.85 → 2.50、极限 2.6 → 3.85）：出界 + 极限终结合计进入 §5.4 目标区间（13–28%），
 *     且误入率（自灭：出界 / 极限前 1.5 s 内无接触）不高于基线 5 个百分点 → 采用；否则回退。
 *  R7 墙恢复 0.5 → 0.2：贴墙率（r > 5.1 的时间占比）不劣于基线，且分构筑胜率无单构筑恶化 > 5 个百分点 → 采用。
 * （墙反弹速度一项需要逐次撞墙测量，本轮先报告贴墙率与撞墙接触段数。）
 */
function withArena<T>(o: { pockets?: [number, number]; wall?: number }, fn: () => T): T {
  const oldW = ARENA.pockets.map((p) => p.width);
  const oldR = ARENA_PHYSICS.wallRestitution;
  if (o.pockets) for (const p of ARENA.pockets) p.width = p.kind === 'xtreme' ? o.pockets[1] : o.pockets[0];
  if (o.wall !== undefined) ARENA_PHYSICS.wallRestitution = o.wall;
  try {
    return fn();
  } finally {
    ARENA.pockets.forEach((p, i) => (p.width = oldW[i]));
    ARENA_PHYSICS.wallRestitution = oldR;
  }
}

test('F：竞技场 A/B（R6 口袋宽度 × R7 墙恢复系数），签名矩阵', async () => {
  const R: RT = await loadRapier();
  const POW = [0.65, 0.8, 0.95];
  const arms: { arm: string; o: { pockets?: [number, number]; wall?: number } }[] = [
    { arm: 'base', o: {} },
    { arm: 'R6', o: { pockets: [2.5, 3.85] } },
    { arm: 'R7', o: { wall: 0.2 } },
    { arm: 'R6+R7', o: { pockets: [2.5, 3.85], wall: 0.2 } },
  ];
  for (const { arm, o } of arms) {
    const recs = withArena(o, () => {
      const rs: { p: string; r: string; kind: string; finish: string | null; own: boolean; winner: string | null; wallP: number; wallR: number; steps: number }[] = [];
      SIGNATURE_LIST.forEach((p, pi) =>
        SIGNATURE_LIST.forEach((r, ri) => {
          for (let i = 0; i < SEEDS; i++) {
            const seed = 20000 + pi * 1000 + ri * 100 + i;
            const rnd = seeded(seed * 7 + 13);
            const sc: Scn = { name: `${p.key}-${r.key}#${i}`, group: 'SIG', player: p.loadout, rival: r.loadout, pCmd: { power: POW[i % 3], aim: (rnd() - 0.5) * 1.2, tilt: 0 }, rCmd: rivalCommand(rnd), seed, maxSeconds: 61, init: '签名矩阵' };
            const orig = Math.random;
            Math.random = seeded(sc.seed);
            try {
              const { pw, b, A, B } = setup(R, sc, { observeContacts: true });
              const max = Math.round(61 / PHYSICS_DT);
              let s = 0;
              let wa = 0;
              let wb = 0;
              for (; s < max && !b.result; s++) {
                pw.step();
                const pa = A.body.translation();
                const pb = B.body.translation();
                if (Math.hypot(pa.x, pa.z) > ARENA.radius - 0.3) wa++;
                if (Math.hypot(pb.x, pb.z) > ARENA.radius - 0.3) wb++;
              }
              const out = b.judgeRound.outcome;
              rs.push({ p: p.key, r: r.key, kind: out?.kind ?? 'none', finish: out?.finish ?? null, own: !!out?.own, winner: out?.winner ?? null, wallP: wa / Math.max(1, s), wallR: wb / Math.max(1, s), steps: s });
              pw.dispose();
            } finally {
              Math.random = orig;
            }
          }
        }),
      );
      return rs;
    });
    const n = recs.length;
    const c: Record<string, number> = {};
    for (const x of recs) {
      const k = x.kind === 'win' ? (x.finish as string) : x.kind;
      c[k] = (c[k] ?? 0) + 1;
    }
    const pocket = (c.over ?? 0) + (c.xtreme ?? 0);
    const own = recs.filter((x) => x.own).length;
    const per: Record<string, unknown> = {};
    for (const sg of SIGNATURE_LIST) {
      let dec = 0;
      let w = 0;
      let wall = 0;
      let m = 0;
      for (const x of recs) {
        const side = x.p === sg.key ? 'player' : x.r === sg.key ? 'rival' : null;
        if (!side || x.p === x.r) continue;
        m++;
        wall += side === 'player' ? x.wallP : x.wallR;
        if (x.kind !== 'win') continue;
        dec++;
        if (x.winner === side) w++;
      }
      per[sg.key] = { winRate: dec ? Math.round((w / dec) * 1000) / 1000 : NaN, decided: dec, wallFrac: Math.round((wall / Math.max(1, m)) * 10000) / 10000 };
    }
    const dflt = recs.filter((x) => x.p === 'senheng' && x.r === 'pandun');
    out(`M5-F ${arm}`, {
      rounds: n,
      shares: Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Math.round((v / n) * 1000) / 1000])),
      pocketShare: Math.round((pocket / n) * 1000) / 1000,
      ownShare: Math.round((own / n) * 1000) / 1000,
      perSignature: per,
      defaultSenhengVsPandun: { n: dflt.length, playerWins: dflt.filter((x) => x.winner === 'player').length },
      durationP50: [...recs.map((x) => x.steps / 120)].sort((a, b) => a - b)[Math.floor(n / 2)],
    });
  }
}, 1_800_000);
