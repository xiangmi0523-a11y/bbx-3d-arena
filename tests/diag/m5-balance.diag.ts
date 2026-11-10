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
import { SMASH_EXPERIMENT } from '../../src/game/battle/BattleSystem';
import { BEY_TUNING } from '../../src/game/beys/BeyPhysics';
import { ARENA, floorHeight } from '../../src/game/arena/arenaSpec';
import type { SpinLedger } from '../../src/game/beys/BeyPhysics';
import { BITS, BLADES, SIGNATURE_LIST } from '../../src/game/beys/parts/catalog';
import { assembleBey, REF_INERTIA } from '../../src/game/beys/parts/assemble';
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

// ───────────────────────────── G. 平衡筛选（探索性，不作采用依据） ─────────────────────────────
/**
 * E7 账本显示：掉速主因是 Rapier 接触摩擦（Bit 倾斜接地的摩擦力矩，随 Bit 摩擦与接地半径增大），而不是 spinDecay；
 * F 显示：口袋加宽几乎不产生击飞（从中心爬出碗沿需约 8.4 m/s）。本部分只筛选候选杠杆的方向与量级，
 * 每臂 320 回合；任何一臂要采用，必须另跑预注册的确认实验（每臂 ≥ 390 回合，规则写在提交说明里）。
 * 臂：base / 接近速度咬合项 approachK 0.6、1.2 / 中心平台取消 centerFlat 0 / 外圈加陡减半 edge 0.03 / 滚动阻力下限 rollBase 0.005。
 */
interface Arm {
  arm: string;
  smash?: number;
  arena?: { centerFlat?: number; edge?: number; bowl?: number };
  tune?: Partial<typeof BEY_TUNING>;
}
function withArm<T>(a: Arm, fn: () => T): T {
  const oldS = SMASH_EXPERIMENT.approachK;
  const oldA = { centerFlat: ARENA.centerFlat, edge: ARENA.edge, bowl: ARENA.bowl };
  const t = BEY_TUNING as unknown as Record<string, number>;
  const oldT: Record<string, number> = {};
  if (a.smash !== undefined) SMASH_EXPERIMENT.approachK = a.smash;
  if (a.arena) Object.assign(ARENA, a.arena);
  for (const [k, v] of Object.entries(a.tune ?? {})) {
    oldT[k] = t[k];
    t[k] = v as number;
  }
  try {
    return fn();
  } finally {
    SMASH_EXPERIMENT.approachK = oldS;
    Object.assign(ARENA, oldA);
    Object.assign(t, oldT);
  }
}

test('G：平衡杠杆筛选（签名矩阵 + 针尖对针尖探针）', async () => {
  const R: RT = await loadRapier();
  const POW = [0.65, 0.8, 0.95];
  const arms: Arm[] = [
    { arm: 'base' },
    { arm: 'approachK0.6', smash: 0.6 },
    { arm: 'approachK1.2', smash: 1.2 },
    { arm: 'centerFlat0', arena: { centerFlat: 0 } },
    { arm: 'edge0.03', arena: { edge: 0.03 } },
    { arm: 'rollBase0.005', tune: { rollBase: 0.005 } },
  ];
  const pandun = SIGNATURE_LIST.find((x) => x.key === 'pandun')!.loadout;
  for (const a of arms) {
    const t0 = Date.now();
    const rep = withArm(a, () => {
      const recs: { p: string; r: string; kind: string; finish: string | null; own: boolean; winner: string | null; steps: number; contacts: number }[] = [];
      SIGNATURE_LIST.forEach((p, pi) =>
        SIGNATURE_LIST.forEach((r, ri) => {
          for (let i = 0; i < SEEDS; i++) {
            const seed = 20000 + pi * 1000 + ri * 100 + i;
            const rnd = seeded(seed * 7 + 13);
            const sc: Scn = { name: `${p.key}-${r.key}#${i}`, group: 'SIG', player: p.loadout, rival: r.loadout, pCmd: { power: POW[i % 3], aim: (rnd() - 0.5) * 1.2, tilt: 0 }, rCmd: rivalCommand(rnd), seed, maxSeconds: 61, init: '签名矩阵' };
            const orig = Math.random;
            Math.random = seeded(sc.seed);
            try {
              const { pw, b } = setup(R, sc, { observeContacts: true });
              const max = Math.round(61 / PHYSICS_DT);
              let s = 0;
              for (; s < max && !b.result; s++) pw.step();
              const o = b.judgeRound.outcome;
              recs.push({ p: p.key, r: r.key, kind: o?.kind ?? 'none', finish: o?.finish ?? null, own: !!o?.own, winner: o?.winner ?? null, steps: s, contacts: b.burst?.episodeCount ?? 0 });
              pw.dispose();
            } finally {
              Math.random = orig;
            }
          }
        }),
      );
      // 针尖对针尖（磐盾镜像）8 场，回合上限 120 s：无接触低速段最长、接触段数
      const probe: { idleMax: number; contacts: number; dur: number }[] = [];
      for (let i = 0; i < 8; i++) {
        const rnd = seeded(7000 + i);
        const sc: Scn = { name: `PvP#${i}`, group: 'PvP', player: pandun, rival: pandun, pCmd: { power: POW[i % 3], aim: (rnd() - 0.5) * 1.2, tilt: 0 }, rCmd: rivalCommand(rnd), seed: 7000 + i, maxSeconds: 120, init: '磐盾镜像' };
        const orig = Math.random;
        Math.random = seeded(sc.seed);
        try {
          const { pw, b, A, B } = setup(R, sc, { observeContacts: true });
          const cs = pw.contacts!;
          let idle = 0;
          let idleMax = 0;
          let s = 0;
          for (; s < 14400 && !b.result; s++) {
            pw.step();
            const imp = cs.bodyPair('player', 'rival')?.normalImpulse ?? 0;
            const va = A.body.linvel();
            const vb = B.body.linvel();
            if (Math.hypot(va.x, va.z) < 0.2 && Math.hypot(vb.x, vb.z) < 0.2 && imp <= 0) idleMax = Math.max(idleMax, (idle += PHYSICS_DT));
            else idle = 0;
          }
          probe.push({ idleMax: Math.round(idleMax * 10) / 10, contacts: b.burst?.episodeCount ?? 0, dur: Math.round((s / 120) * 10) / 10 });
          pw.dispose();
        } finally {
          Math.random = orig;
        }
      }
      return { recs, probe };
    });
    const { recs, probe } = rep;
    const n = recs.length;
    const c: Record<string, number> = {};
    for (const x of recs) {
      const k = x.kind === 'win' ? (x.finish as string) : x.kind;
      c[k] = (c[k] ?? 0) + 1;
    }
    const per: Record<string, number> = {};
    for (const sg of SIGNATURE_LIST) {
      let dec = 0;
      let w = 0;
      for (const x of recs) {
        const side = x.p === sg.key ? 'player' : x.r === sg.key ? 'rival' : null;
        if (!side || x.p === x.r || x.kind !== 'win') continue;
        dec++;
        if (x.winner === side) w++;
      }
      per[sg.key] = dec ? Math.round((w / dec) * 1000) / 1000 : NaN;
    }
    const dflt = recs.filter((x) => x.p === 'senheng' && x.r === 'pandun');
    out(`M5-G ${a.arm}`, {
      ms: Date.now() - t0,
      rounds: n,
      shares: Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Math.round((v / n) * 1000) / 1000])),
      own: recs.filter((x) => x.own).length,
      winRate: per,
      defaultPlayerWins: `${dflt.filter((x) => x.winner === 'player').length}/${dflt.length}`,
      durationP50: [...recs.map((x) => x.steps / 120)].sort((x, y) => x - y)[Math.floor(n / 2)],
      contactsP50: [...recs.map((x) => x.contacts)].sort((x, y) => x - y)[Math.floor(n / 2)],
      needleMirror: probe,
    });
  }
}, 3_000_000);

// ───────────────────────────── H. 零件参数筛选（探索性，不作采用依据） ─────────────────────────────
/**
 * G 的结论：咬合接近速度项、中心平台、外圈坡度、滚动阻力下限都没有动摇磐盾（胜率 94–98%）——
 * 防守优势不在竞技场或咬合模型，而在“谁掉速慢”（自转终结约 77%）。本部分筛选零件参数：
 *  - v2.0 §3.4 列出的调参候选：针尖 spinDecay 0.85 ↑（2.0 / 3.0）、圆球 spinDecay 1.2 ↓（0.6）、泰坦王冠 rimWeight 0.78 ↑（0.95）；
 *  - E7 账本指向的主因：Bit 接地摩擦（Rapier 接触积分掉速与 Bit 摩擦同序）——针尖 0.12 → 0.2、平齿 / 橡胶 0.45 → 0.32；
 *  - 组合臂：针尖 2.0 + 圆球 0.6 + 平齿 / 橡胶 0.32。
 * 每臂 320 回合（每个无序对阵 40 回合，95% CI 半宽约 ±15 个点：只看方向与量级）。
 * 输出（行首 M5-H）：对阵胜率（v2.0 §3.4 的三条克制链 + 默认对局）、各构筑的平均账本（基础衰减 / Rapier 接触损失 / 终局转速）、
 * v2.0 定义的“生效衰减率”（spinDecay × REF_INERTIA / spinInertia）及其最大差。
 */
type PartTweak = { kind: 'bit' | 'blade'; id: string; field: string; value: number };
interface PartArm {
  arm: string;
  parts: PartTweak[];
}
function withParts<T>(tw: PartTweak[], fn: () => T): T {
  const old: { o: Record<string, number>; f: string; v: number }[] = [];
  for (const t of tw) {
    const o = (t.kind === 'bit' ? BITS[t.id] : BLADES[t.id]) as unknown as Record<string, number>;
    old.push({ o, f: t.field, v: o[t.field] });
    o[t.field] = t.value;
  }
  try {
    return fn();
  } finally {
    for (const x of old.reverse()) x.o[x.f] = x.v;
  }
}

test('H：零件参数筛选（v2.0 §3.4 候选 + Bit 摩擦）', async () => {
  const R: RT = await loadRapier();
  const POW = [0.65, 0.8, 0.95];
  const needle = (v: number): PartTweak => ({ kind: 'bit', id: 'needle-point', field: 'spinDecay', value: v });
  const ball = (v: number): PartTweak => ({ kind: 'bit', id: 'dome-ball', field: 'spinDecay', value: v });
  const fric = (v: number): PartTweak[] => [
    { kind: 'bit', id: 'gear-flat', field: 'friction', value: v },
    { kind: 'bit', id: 'rush-rubber', field: 'friction', value: v },
  ];
  const arms: PartArm[] = [
    { arm: 'base', parts: [] },
    { arm: 'needleDecay2.0', parts: [needle(2.0)] },
    { arm: 'needleDecay3.0', parts: [needle(3.0)] },
    { arm: 'ballDecay0.6', parts: [ball(0.6)] },
    { arm: 'crownRim0.95', parts: [{ kind: 'blade', id: 'titan-crown', field: 'rimWeight', value: 0.95 }] },
    { arm: 'needleFric0.2', parts: [{ kind: 'bit', id: 'needle-point', field: 'friction', value: 0.2 }] },
    { arm: 'flatRubberFric0.32', parts: fric(0.32) },
    { arm: 'combo', parts: [needle(2.0), ball(0.6), ...fric(0.32)] },
  ];
  const PAIRS: [string, string, string][] = [
    ['A>S', 'lieren', 'ziyao'],
    ['S>D', 'ziyao', 'pandun'],
    ['D>A', 'pandun', 'lieren'],
    ['default', 'senheng', 'pandun'],
    ['B-A', 'senheng', 'lieren'],
    ['B-S', 'senheng', 'ziyao'],
  ];
  for (const a of arms) {
    const t0 = Date.now();
    const rep = withParts(a.parts, () => {
      const recs: { p: string; r: string; kind: string; finish: string | null; winner: string | null; steps: number; sides: Side[] }[] = [];
      const eff: Record<string, number> = {};
      for (const sg of SIGNATURE_LIST) {
        const sp = assembleBey(sg.loadout);
        eff[sg.key] = r2((sp.bit.spinDecay * REF_INERTIA) / sp.spinInertia);
      }
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
              for (; s < max && !b.result; s++) pw.step();
              const o = b.judgeRound.outcome;
              const won = (side: 'player' | 'rival') => (o && o.kind === 'win' ? o.winner === side : null);
              recs.push({
                p: p.key,
                r: r.key,
                kind: o?.kind ?? 'none',
                finish: o?.finish ?? null,
                winner: o?.winner ?? null,
                steps: s,
                sides: [
                  { key: p.key, launch: A.launchSpin, end: A.spin, ledger: { ...A.ledger }, won: won('player') },
                  { key: r.key, launch: B.launchSpin, end: B.spin, ledger: { ...B.ledger }, won: won('rival') },
                ],
              });
              pw.dispose();
            } finally {
              Math.random = orig;
            }
          }
        }),
      );
      return { recs, eff };
    });
    const { recs, eff } = rep;
    const n = recs.length;
    const c: Record<string, number> = {};
    for (const x of recs) {
      const k = x.kind === 'win' ? (x.finish as string) : x.kind;
      c[k] = (c[k] ?? 0) + 1;
    }
    const pairs: Record<string, string> = {};
    for (const [tag, x, y] of PAIRS) {
      let wx = 0;
      let wy = 0;
      let d = 0;
      for (const q of recs) {
        if (!((q.p === x && q.r === y) || (q.p === y && q.r === x))) continue;
        const xs = q.p === x ? 'player' : 'rival';
        if (q.kind !== 'win') {
          d++;
          continue;
        }
        if (q.winner === xs) wx++;
        else wy++;
      }
      pairs[tag] = `${x} ${wx}:${wy} ${y}（平 ${d}）`;
    }
    const perSig: Record<string, unknown> = {};
    for (const sg of SIGNATURE_LIST) {
      let dec = 0;
      let w = 0;
      for (const x of recs) {
        const side = x.p === sg.key ? 'player' : x.r === sg.key ? 'rival' : null;
        if (!side || x.p === x.r || x.kind !== 'win') continue;
        dec++;
        if (x.winner === side) w++;
      }
      const sides = recs.filter((x) => x.p !== x.r).flatMap((x) => x.sides).filter((s) => s.key === sg.key);
      const m = sides.length || 1;
      perSig[sg.key] = {
        win: dec ? Math.round((w / dec) * 1000) / 1000 : NaN,
        base: r2(sides.reduce((s, v) => s + v.ledger.base, 0) / m),
        contactLoss: r2(sides.reduce((s, v) => s + v.ledger.contactLoss, 0) / m),
        end: r2(sides.reduce((s, v) => s + v.end, 0) / m),
        effDecay: eff[sg.key],
      };
    }
    const ev = Object.values(eff);
    out(`M5-H ${a.arm}`, {
      ms: Date.now() - t0,
      rounds: n,
      shares: Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Math.round((v / n) * 1000) / 1000])),
      pairs,
      perSignature: perSig,
      effDecaySpreadPct: Math.round((Math.max(...ev) / Math.min(...ev) - 1) * 100),
      durationP50: [...recs.map((x) => x.steps / 120)].sort((x, y) => x - y)[Math.floor(n / 2)],
    });
  }
}, 3_000_000);

// ───────────────────────────── I. 接触掉速的来源分解（只读诊断） ─────────────────────────────
/**
 * H 的意外结果：把针尖摩擦 0.12 → 0.2、平齿 / 橡胶 0.45 → 0.32，各构筑的“Rapier 接触积分损失”几乎不变（±4%）——
 * 账本 §2 里“接触损失随 Bit 摩擦同序”是相关、不是因果。本部分把每一步的接触损失按
 * （上一步是否有陀螺对陀螺的法向冲量）×（倾角区间）分桶，给出每桶的时间占比与掉速率（rad/s 每秒）；
 * 并做两个只读对照臂：刀刃摩擦全部置 0（隔离陀螺对陀螺的摩擦）、Bit 摩擦全部减半（复核地面摩擦）。
 * 另给出 base 下每个无序对阵按终结方式的胜负明细（谁、怎么赢的）。
 */
test('I：接触掉速来源分解（对撞 / 倾角分桶 + 刀刃摩擦 0 / Bit 摩擦减半 对照）', async () => {
  const R: RT = await loadRapier();
  const POW = [0.65, 0.8, 0.95];
  const halfBits: PartTweak[] = Object.keys(BITS).map((id) => ({ kind: 'bit', id, field: 'friction', value: BITS[id].friction / 2 }));
  const zeroBlades: PartTweak[] = Object.keys(BLADES).map((id) => ({ kind: 'blade', id, field: 'friction', value: 0 }));
  const arms: PartArm[] = [
    { arm: 'base', parts: [] },
    { arm: 'bladeFric0', parts: zeroBlades },
    { arm: 'bitFricHalf', parts: halfBits },
  ];
  const BINS = ['hit', 't<0.05', 't0.05-0.15', 't0.15-0.3', 't>0.3', 'air'] as const;
  type Bin = (typeof BINS)[number];
  for (const a of arms) {
    const t0 = Date.now();
    const res = withParts(a.parts, () => {
      const acc: Record<string, Record<Bin, { t: number; loss: number; gain: number }>> = {};
      const fin: Record<string, Record<string, number>> = {};
      const wins: Record<string, number> = {};
      const dec: Record<string, number> = {};
      for (const sg of SIGNATURE_LIST) acc[sg.key] = Object.fromEntries(BINS.map((b) => [b, { t: 0, loss: 0, gain: 0 }])) as Record<Bin, { t: number; loss: number; gain: number }>;
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
              const cs = pw.contacts!;
              const max = Math.round(61 / PHYSICS_DT);
              const sides = [
                { bey: A, key: p.key, prevL: 0, prevG: 0, bin: 'air' as Bin },
                { bey: B, key: r.key, prevL: 0, prevG: 0, bin: 'air' as Bin },
              ];
              for (let s = 0; s < max && !b.result; s++) {
                pw.step();
                // 本步测到的账本增量对应上一步的 Rapier 积分 → 用上一步记下的桶
                for (const sd of sides) {
                  const L = sd.bey.ledger;
                  if (p.key !== r.key) {
                    const cell = acc[sd.key][sd.bin];
                    cell.t += PHYSICS_DT;
                    cell.loss += L.contactLoss - sd.prevL;
                    cell.gain += L.contactGain - sd.prevG;
                  }
                  sd.prevL = L.contactLoss;
                  sd.prevG = L.contactGain;
                }
                const hit = (cs.bodyPair('player', 'rival')?.normalImpulse ?? 0) > 0;
                for (const sd of sides) {
                  const tl = sd.bey.tilt;
                  sd.bin = hit ? 'hit' : !sd.bey.grounded ? 'air' : tl < 0.05 ? 't<0.05' : tl < 0.15 ? 't0.05-0.15' : tl < 0.3 ? 't0.15-0.3' : 't>0.3';
                }
              }
              const o = b.judgeRound.outcome;
              if (p.key !== r.key && o && o.kind === 'win') {
                const wk = o.winner === 'player' ? p.key : r.key;
                const lk = o.winner === 'player' ? r.key : p.key;
                const pair = [p.key, r.key].sort().join('-');
                fin[pair] ??= {};
                fin[pair][`${wk}:${o.finish}`] = (fin[pair][`${wk}:${o.finish}`] ?? 0) + 1;
                wins[wk] = (wins[wk] ?? 0) + 1;
                dec[wk] = (dec[wk] ?? 0) + 1;
                dec[lk] = (dec[lk] ?? 0) + 1;
              }
              pw.dispose();
            } finally {
              Math.random = orig;
            }
          }
        }),
      );
      return { acc, fin, wins, dec };
    });
    const per: Record<string, unknown> = {};
    for (const sg of SIGNATURE_LIST) {
      const cells = res.acc[sg.key];
      const T = BINS.reduce((s, b) => s + cells[b].t, 0) || 1;
      const L = BINS.reduce((s, b) => s + cells[b].loss, 0) || 1;
      per[sg.key] = {
        win: r2((res.wins[sg.key] ?? 0) / Math.max(1, res.dec[sg.key] ?? 0)),
        bins: Object.fromEntries(
          BINS.map((b) => [b, { timePct: r2((cells[b].t / T) * 100), lossPct: r2((cells[b].loss / L) * 100), lossRate: r2(cells[b].loss / Math.max(1e-6, cells[b].t)), gainRate: r2(cells[b].gain / Math.max(1e-6, cells[b].t)) }]),
        ),
        lossPerSec: r2(L / T),
      };
    }
    out(`M5-I ${a.arm}`, { ms: Date.now() - t0, perSignature: per, finishes: res.fin });
  }
}, 3_000_000);

// ───────────────────────────── J. 碗面深度筛选（探索性，竞技场几何：采用需 Huang 确认） ─────────────────────────────
/**
 * I 的结论：对撞期间两边的掉速大致对称（Rapier 摩擦冲量作用在双方），攻击型的额外掉速来自滚动移动；
 * 攻击型赢不了的根本原因是击飞几乎不可能（从中心爬出碗沿约需 8.4 m/s）。本部分只筛选碗面深度（碗沿高度）对终结分布与平衡的影响：
 *   base（bowl 0.045，碗沿 1.76）/ bowl 0.03（1.33）/ bowl 0.03 + edge 0.03（1.16）/ bowl 0.02 + edge 0.03（0.87）/ bowl 0.03 + edge 0.03 + centerFlat 0。
 * v2.0 §5.4 标准场目标：自转 55–65%、出界 10–20%、爆裂 15–25%、极限 3–8%、回合 12–18 s；自灭（出界前 1.5 s 无接触）不高于基线 5 个点。
 */
test('J：碗面深度筛选（终结分布 + 对阵 + 自灭）', async () => {
  const R: RT = await loadRapier();
  const POW = [0.65, 0.8, 0.95];
  const arms: Arm[] = [
    { arm: 'base' },
    { arm: 'bowl0.03', arena: { bowl: 0.03 } },
    { arm: 'bowl0.03+edge0.03', arena: { bowl: 0.03, edge: 0.03 } },
    { arm: 'bowl0.02+edge0.03', arena: { bowl: 0.02, edge: 0.03 } },
    { arm: 'bowl0.03+edge0.03+flat0', arena: { bowl: 0.03, edge: 0.03, centerFlat: 0 } },
  ];
  const PAIRS: [string, string, string][] = [
    ['A>S', 'lieren', 'ziyao'],
    ['S>D', 'ziyao', 'pandun'],
    ['D>A', 'pandun', 'lieren'],
    ['default', 'senheng', 'pandun'],
    ['B-A', 'senheng', 'lieren'],
    ['B-S', 'senheng', 'ziyao'],
  ];
  for (const a of arms) {
    const t0 = Date.now();
    const recs = withArm(a, () => {
      const rs: { p: string; r: string; kind: string; finish: string | null; own: boolean; winner: string | null; steps: number }[] = [];
      SIGNATURE_LIST.forEach((p, pi) =>
        SIGNATURE_LIST.forEach((r, ri) => {
          for (let i = 0; i < SEEDS; i++) {
            const seed = 20000 + pi * 1000 + ri * 100 + i;
            const rnd = seeded(seed * 7 + 13);
            const sc: Scn = { name: `${p.key}-${r.key}#${i}`, group: 'SIG', player: p.loadout, rival: r.loadout, pCmd: { power: POW[i % 3], aim: (rnd() - 0.5) * 1.2, tilt: 0 }, rCmd: rivalCommand(rnd), seed, maxSeconds: 61, init: '签名矩阵' };
            const orig = Math.random;
            Math.random = seeded(sc.seed);
            try {
              const { pw, b } = setup(R, sc, { observeContacts: true });
              const max = Math.round(61 / PHYSICS_DT);
              let s = 0;
              for (; s < max && !b.result; s++) pw.step();
              const o = b.judgeRound.outcome;
              rs.push({ p: p.key, r: r.key, kind: o?.kind ?? 'none', finish: o?.finish ?? null, own: !!o?.own, winner: o?.winner ?? null, steps: s });
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
    const pairs: Record<string, string> = {};
    for (const [tag, x, y] of PAIRS) {
      let wx = 0;
      let wy = 0;
      let d = 0;
      const how: Record<string, number> = {};
      for (const q of recs) {
        if (!((q.p === x && q.r === y) || (q.p === y && q.r === x))) continue;
        const xs = q.p === x ? 'player' : 'rival';
        if (q.kind !== 'win') {
          d++;
          continue;
        }
        const w = q.winner === xs ? x : y;
        if (w === x) wx++;
        else wy++;
        const hk = `${w}:${q.finish}${q.own ? '(自灭)' : ''}`;
        how[hk] = (how[hk] ?? 0) + 1;
      }
      pairs[tag] = `${x} ${wx}:${wy} ${y}（平 ${d}）${JSON.stringify(how)}`;
    }
    const per: Record<string, number> = {};
    for (const sg of SIGNATURE_LIST) {
      let dec = 0;
      let w = 0;
      for (const x of recs) {
        const side = x.p === sg.key ? 'player' : x.r === sg.key ? 'rival' : null;
        if (!side || x.p === x.r || x.kind !== 'win') continue;
        dec++;
        if (x.winner === side) w++;
      }
      per[sg.key] = dec ? Math.round((w / dec) * 1000) / 1000 : NaN;
    }
    const rim = floorHeight(ARENA.radius, { ...ARENA, ...(a.arena ?? {}) });
    out(`M5-J ${a.arm}`, {
      ms: Date.now() - t0,
      rimHeight: r2(rim),
      escapeSpeed: r2(Math.sqrt(2 * 20 * rim)),
      rounds: n,
      shares: Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Math.round((v / n) * 1000) / 1000])),
      ownShare: Math.round((recs.filter((x) => x.own).length / n) * 1000) / 1000,
      winRate: per,
      pairs,
      durationP50: [...recs.map((x) => x.steps / 120)].sort((x, y) => x - y)[Math.floor(n / 2)],
    });
  }
}, 3_000_000);
