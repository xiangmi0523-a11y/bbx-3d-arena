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
