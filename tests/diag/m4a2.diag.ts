/// <reference types="node" />
/**
 * M4-A2 单台标定网格（docs/engineering/m4-experiment-plan.md §4.2，预注册）。
 * 固定开关：陀螺项开、自稳 PD 关、显式牵引关、牵引方向取实际倾斜、平底 / 橡胶轴心圆角圆柱接地、合成刮地关（即 B3），物理 480 Hz（k = 4）。
 * 网格：g ∈ {60, 80, 100}，地面摩擦 × 20 / g（μg 不变）；发射转速尺度 s ∈ {1.0, 1.4}；平底边缘倒圆 b ∈ {0.03, 0.05}。共 12 组。
 * 每组跑 M4-A 的单台套件（四个签名构筑 3 力度 × 2 种子 + 森衡换 4 种轴心 × 3 种子，共 36 台），按 §4.2 的 G1–G5 判定；
 * 多组通过时取会移动构筑 E2a 最小值最大的一组；没有一组通过就报告，不放宽门槛。输出行首 M4A2-。
 *
 * 转速尺度 s 的实现（只用于单台）：装配结果的 maxSpin、轴心基础衰减 spinDecay 乘 s（返回副本，不改零件目录）；
 * 与转速绝对值比较的阈值同乘 s：终结判定的 stopSpin / toppleSpin、BEY_TUNING.minStableSpin、轨道冲刺的 railSpinCost。
 * 所有开关只在本文件运行期间设置，结束后恢复（golden 不受影响）。
 */
import { test } from 'vitest';
import { ARENA } from '../../src/game/arena/arenaSpec';
import { FINISH_TUNING } from '../../src/game/battle/BattleSystem';
import { BEY_TUNING } from '../../src/game/beys/BeyPhysics';
import { beyMassProps } from '../../src/game/beys/massProps';
import { assembleBey, type AssembledBey } from '../../src/game/beys/parts/assemble';
import { SIGNATURE_LIST } from '../../src/game/beys/parts/catalog';
import { FLAT_TIP, GYRO_EXPERIMENT } from '../../src/game/physics/gyro';
import { loadRapier, PHYSICS_EXPERIMENT } from '../../src/game/physics/PhysicsWorld';
import { median, r2, r3 } from './m4.metrics';
import { soloSuite, type SoloRec } from './m4.runs';
import { out } from './m5b.shared';

const SWITCHES = { enabled: 1, pd: 0, tiltDrive: 1, flatTip: 1, explicitDrive: 0, scrape: 0 };
const GS = [60, 80, 100];
const SS = [1.0, 1.4];
const BS = [0.03, 0.05];
const MOVERS = ['lieren', 'senheng', 'ziyao'];
const SIGS: string[] = SIGNATURE_LIST.map((s) => s.key);
/** M4-A 单台寿命中位（m4a-baseline.md，CI 43029289458） */
const M4A_LIFE: Record<string, number> = { ziyao: 85.95, pandun: 123.88 };

type Bin = { ratio: string; seconds: number; speed: number; r?: number };

/** E2（与 m4b.diag.ts 同一口径）：0.5–0.6 档 / 0.8–1.0 档、0.3–0.4 档 / 0.8–1.0 档、0.2 以上相邻档最小比 */
function e2Of(bins: Bin[]) {
  const get = (lo: string) => bins.find((b) => b.ratio.startsWith(lo));
  const hi = [get('0.9'), get('0.8')].filter((b): b is Bin => !!b);
  const secs = hi.reduce((a, b) => a + b.seconds, 0);
  const top = secs ? hi.reduce((a, b) => a + b.speed * b.seconds, 0) / secs : NaN;
  const s05 = get('0.5')?.speed ?? NaN;
  const s03 = get('0.3')?.speed ?? NaN;
  let minAdj = Infinity;
  for (let k = 9; k > 2; k--) {
    const a = get((k / 10).toFixed(1));
    const b = get(((k - 1) / 10).toFixed(1));
    if (a && b && a.speed > 1e-3) minAdj = Math.min(minAdj, b.speed / a.speed);
  }
  return { a: r3(s05 / top), b: r3(s03 / top), minAdj: r3(minAdj), pass: s05 / top >= 0.65 && s03 / top >= 0.4 && minAdj >= 0.6 };
}

const prepOf = (s: number) => (spec: AssembledBey): AssembledBey => (s === 1 ? spec : { ...spec, maxSpin: spec.maxSpin * s, bit: { ...spec.bit, spinDecay: spec.bit.spinDecay * s } });

function withCfg<T>(g: number, s: number, b: number, fn: () => T): T {
  const gy = { ...GYRO_EXPERIMENT };
  const ph = { ...PHYSICS_EXPERIMENT };
  const ft = { ...FLAT_TIP };
  const fin = { stopSpin: FINISH_TUNING.stopSpin, toppleSpin: FINISH_TUNING.toppleSpin };
  const bt = { minStableSpin: BEY_TUNING.minStableSpin, railSpinCost: BEY_TUNING.railSpinCost };
  Object.assign(GYRO_EXPERIMENT, SWITCHES);
  Object.assign(PHYSICS_EXPERIMENT, { substeps: 4, gravity: g, floorFriction: 20 / g });
  FLAT_TIP.border = b;
  FINISH_TUNING.stopSpin = fin.stopSpin * s;
  FINISH_TUNING.toppleSpin = fin.toppleSpin * s;
  BEY_TUNING.minStableSpin = bt.minStableSpin * s;
  BEY_TUNING.railSpinCost = bt.railSpinCost * s;
  try {
    return fn();
  } finally {
    Object.assign(GYRO_EXPERIMENT, gy);
    Object.assign(PHYSICS_EXPERIMENT, ph);
    Object.assign(FLAT_TIP, ft);
    Object.assign(FINISH_TUNING, fin);
    Object.assign(BEY_TUNING, bt);
  }
}

/** 理论临界转速比例（力度 0.8）与发射时的重力进动，按本组 g、s 与平底形状 */
function theory(g: number, s: number) {
  const rows: Record<string, unknown> = {};
  for (const sg of SIGNATURE_LIST) {
    const spec = assembleBey(sg.loadout);
    const flat = spec.bit.visual.shape === 'gear-flat' || spec.bit.visual.shape === 'rubber';
    const mp = beyMassProps(spec, { flatTip: flat ? FLAT_TIP : null });
    const l = mp.comY - spec.bit.contactRadius;
    const wc = Math.sqrt(4 * mp.mass * g * l * (mp.It + mp.mass * l * l)) / mp.Ia;
    const w0 = spec.maxSpin * s * (0.4 + 0.6 * 0.8);
    rows[sg.key] = { critRatio: r3(wc / w0), precessionAtLaunch: r3((mp.mass * g * l) / (mp.Ia * w0)) };
  }
  return rows;
}

function gates(solo: ReturnType<typeof soloSuite>) {
  const by = solo.byName as Record<string, Record<string, unknown>>;
  const sigRuns = solo.recs.filter((x: SoloRec) => SIGS.includes(x.name));
  // G1 原地滚边：全部 36 台都没有（比例 ≥ 0.3 时连续 ≥ 2 s）
  const g1v = Math.max(...solo.recs.map((x) => x.rollInPlaceMax));
  // G2 烈刃、森衡中段平均半径 0.30–0.55 R
  const g2v: Record<string, number> = {};
  for (const k of ['lieren', 'senheng']) g2v[k] = r3((by[k].rMidP50 as number) / ARENA.radius);
  // G3 E2（会移动的构筑）+ E3 ≥ 0.5
  const E2: Record<string, ReturnType<typeof e2Of>> = {};
  const E3: Record<string, number | null> = {};
  for (const k of MOVERS) {
    E2[k] = e2Of(by[k].bins as Bin[]);
    E3[k] = by[k].last3SpeedOverMidP50 as number | null;
  }
  // G4 紫曜、磐盾：比例 > 0.3 时没有持续 ≥ 0.2 s 的超出倾角 ≥ 0.25 rad（发射后 1 s 不计），单台寿命中位 ≥ M4-A 的 60%
  const g4v: Record<string, { excursionMax: number; lifeP50: number; lifeMin: number }> = {};
  for (const k of ['ziyao', 'pandun']) g4v[k] = { excursionMax: by[k].excursionAbove03Max as number, lifeP50: by[k].endAtP50 as number, lifeMin: r2(0.6 * M4A_LIFE[k]) };
  // G5 四个签名构筑 24 台：终结有失衡过程 ≥ 80%，过程中位 1–4 s
  const dShare = sigRuns.filter((x) => x.destabDuration !== null).length / sigRuns.length;
  const dP50 = median(sigRuns.map((x) => x.destabDuration).filter((v): v is number => v !== null));
  const G = {
    G1: { rollInPlaceMax: g1v, pass: g1v < 2 },
    G2: { rMidOverR: g2v, pass: Object.values(g2v).every((v) => v >= 0.3 && v <= 0.55) },
    G3: { E2, E3, pass: MOVERS.every((k) => E2[k].pass && (E3[k] ?? 0) >= 0.5) },
    G4: { ...g4v, pass: Object.values(g4v).every((v) => v.excursionMax < 0.2 && v.lifeP50 >= v.lifeMin) },
    G5: { destabShare: r3(dShare), destabP50: r2(dP50), pass: dShare >= 0.8 && dP50 >= 1 && dP50 <= 4 },
  };
  const pass = G.G1.pass && G.G2.pass && G.G3.pass && G.G4.pass && G.G5.pass;
  const score = Math.min(...MOVERS.map((k) => (Number.isFinite(E2[k].a) ? E2[k].a : -Infinity)));
  return { pass, score: r3(score), ...G };
}

const results: { cfg: string; pass: boolean; score: number; failed: string[] }[] = [];

for (const g of GS)
  for (const s of SS)
    for (const b of BS) {
      const cfg = `g${g}-s${s}-b${b}`;
      test(`M4-A2 ${cfg}`, async () => {
        const R = await loadRapier();
        const res = withCfg(g, s, b, () => {
          const th = theory(g, s);
          const solo = soloSuite(R, { prep: prepOf(s) });
          const gt = gates(solo);
          return { th, solo, gt };
        });
        for (const x of res.solo.recs) out('M4A2-RUN', { cfg, ...x });
        out('M4A2-SOLO', { cfg, ms: res.solo.ms, byName: res.solo.byName });
        out('M4A2-CFG', { cfg, g, s, b, floorFriction: r3(20 / g), theory: res.th, gates: res.gt });
        const failed = (['G1', 'G2', 'G3', 'G4', 'G5'] as const).filter((k) => !res.gt[k].pass);
        results.push({ cfg, pass: res.gt.pass, score: res.gt.score, failed });
      });
    }

test('M4-A2 结论', () => {
  const passing = results.filter((x) => x.pass).sort((a, b) => b.score - a.score);
  out('M4A2-RESULT', { configs: results, passing: passing.map((x) => x.cfg), selected: passing.length ? passing[0].cfg : null });
});
