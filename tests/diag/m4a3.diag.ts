/// <reference types="node" />
/**
 * M4-A3 签名矩阵（docs/engineering/m4-experiment-plan.md §4.2，预注册）：在 A2 选中的一组上加 B4（wobbleBreak、edgeGrip 关），
 * 跑单台套件（E3、E6）、确定性、筛选集 20000 × 20；筛选通过再跑确认集 60000 × 40。判定 E1–E6 与全程不退化（§3，与 B 阶段同一口径）。
 * 必须通过 E1、E2、E3、E5 与全程不退化。输出行首 M4A3-。所有开关只在本文件运行期间设置，结束后恢复。
 *
 * 用法：M4A3_CFG=g80-s1-b0.05 npx vitest run --config vitest.diag.config.ts tests/diag/m4a3.diag.ts
 */
import { test } from 'vitest';
import { BEY_TUNING } from '../../src/game/beys/BeyPhysics';
import { FLAT_TIP, GYRO_EXPERIMENT } from '../../src/game/physics/gyro';
import { loadRapier, PHYSICS_EXPERIMENT } from '../../src/game/physics/PhysicsWorld';
import { critRatio, deterministic, evaluate, report, type Group } from './m4.eval';
import { runSet, soloSuite, type Example, type R } from './m4.runs';
import { matrixScenarios, out } from './m5b.shared';

const SWITCHES = { enabled: 1, pd: 0, tiltDrive: 1, flatTip: 1, explicitDrive: 0, scrape: 0 };
const REQUIRES: Group[] = ['E1', 'E2', 'E3', 'E5'];

function parseCfg(name: string) {
  const m = /^g(\d+(?:\.\d+)?)-s(\d+(?:\.\d+)?)-b(\d+(?:\.\d+)?)$/.exec(name);
  if (!m) throw new Error(`M4A3_CFG 格式应为 g80-s1-b0.05，收到 ${name}`);
  return { g: Number(m[1]), s: Number(m[2]), b: Number(m[3]) };
}

function withCfg<T>(g: number, b: number, fn: () => T): T {
  const gy = { ...GYRO_EXPERIMENT };
  const ph = { ...PHYSICS_EXPERIMENT };
  const ft = { ...FLAT_TIP };
  const bt = { wobbleBreak: BEY_TUNING.wobbleBreak, edgeGrip: BEY_TUNING.edgeGrip };
  Object.assign(GYRO_EXPERIMENT, SWITCHES);
  Object.assign(PHYSICS_EXPERIMENT, { substeps: 4, gravity: g, floorFriction: 20 / g });
  FLAT_TIP.border = b;
  BEY_TUNING.wobbleBreak = 0;
  BEY_TUNING.edgeGrip = 0;
  try {
    return fn();
  } finally {
    Object.assign(GYRO_EXPERIMENT, gy);
    Object.assign(PHYSICS_EXPERIMENT, ph);
    Object.assign(FLAT_TIP, ft);
    Object.assign(BEY_TUNING, bt);
  }
}

const name = process.env.M4A3_CFG;
const state: { R?: R; solo?: ReturnType<typeof soloSuite>; det?: boolean; screenPass?: boolean } = {};

test('M4-A3 单台 + 确定性', async () => {
  if (!name) return console.log('未设置 M4A3_CFG，跳过');
  const { g, s, b } = parseCfg(name);
  if (s !== 1) throw new Error('转速尺度 s ≠ 1 需要先实现对局里的同等缩放（计划 §4.2 A2 判定口径）');
  state.R = await loadRapier();
  out('M4A3-ARM', { cfg: name, g, s, b, switches: SWITCHES, wobbleBreak: 0, edgeGrip: 0, substeps: 4, floorFriction: 20 / g });
  withCfg(g, b, () => {
    state.solo = soloSuite(state.R!);
    for (const x of state.solo.recs) out('M4A3-SOLO-RUN', x);
    out('M4A3-SOLO', { ms: state.solo.ms, byName: state.solo.byName });
    state.det = deterministic(state.R!, 16);
    out('M4A3-DETERMINISM', { pass: state.det });
  });
}, 3_000_000);

test('M4-A3 筛选集 20000 × 20', () => {
  if (!name || !state.solo) return;
  const { g, b } = parseCfg(name);
  withCfg(g, b, () => {
    const ex: Example[] = [];
    const set = runSet(state.R!, matrixScenarios(20000, 20), 'screen', ex);
    report('M4A3-SCREEN', set, ex);
    const v = evaluate(REQUIRES, state.solo!, set, state.det!, (k) => critRatio(k, g));
    out('M4A3-SCREEN-VERDICT', v);
    state.screenPass = v.pass;
  });
}, 3_000_000);

test('M4-A3 确认集 60000 × 40（筛选通过才跑）', () => {
  if (!name || !state.solo) return;
  const { g, b } = parseCfg(name);
  let confirm: boolean | null = null;
  if (state.screenPass)
    withCfg(g, b, () => {
      const ex: Example[] = [];
      const set = runSet(state.R!, matrixScenarios(60000, 40), 'confirm', ex);
      report('M4A3-CONFIRM', set, ex);
      const v = evaluate(REQUIRES, state.solo!, set, state.det!, (k) => critRatio(k, g));
      out('M4A3-CONFIRM-VERDICT', v);
      confirm = v.pass;
    });
  out('M4A3-RESULT', { cfg: name, screenPass: state.screenPass ?? false, confirmPass: confirm, adopted: state.screenPass === true && confirm === true });
}, 3_000_000);
