/// <reference types="node" />
/**
 * 惯量契约诊断（产品总方案 v2.0 §11.3 / R12；只读）。
 *
 * 游戏层规则（转速衰减、陀螺自稳、撞击掉速）一律用标量 spinInertia = Σ m·r²·rimWeight（assemble.ts）；
 * Rapier 求解器用的是由碰撞体质量与形状算出的完整惯量张量（球 2/5·m·r²、圆柱 ½·m·r² + 平行轴项）。
 * 本诊断对 64 种组合逐一读取 Rapier 的主惯量（principalInertia）与局部质心，和游戏层标量对照，
 * 差值 > 5% 的列出原因，不改任何参数。
 *
 * 用法：npx vitest run --config vitest.diag.config.ts tests/diag/inertia.diag.ts
 * 输出：test-results/inertia/contract.json
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'vitest';
import { BeyPhysics } from '../../src/game/beys/BeyPhysics';
import { assembleBey } from '../../src/game/beys/parts/assemble';
import { listParts } from '../../src/game/beys/parts/catalog';
import { loadRapier, PhysicsWorld } from '../../src/game/physics/PhysicsWorld';

const log = (...a: unknown[]) => process.stderr.write(a.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ') + '\n');
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

test('惯量契约：游戏层标量 vs Rapier 主惯量（64 组合）', async () => {
  const R = await loadRapier();
  const rows: { loadout: string; mass: number; comY: number; gameSpin: number; rapierIy: number; rapierIxz: number[]; diffPct: number }[] = [];
  for (const bl of listParts('blade'))
    for (const d of listParts('ratchet'))
      for (const t of listParts('bit')) {
        const spec = assembleBey({ blade: bl.id, ratchet: d.id, bit: t.id });
        const pw = new PhysicsWorld(R);
        const bey = new BeyPhysics(pw, spec, { position: { x: 0, y: 2, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, spin: 0, seed: 1 });
        const I = bey.body.principalInertia();
        const com = bey.body.localCom();
        const game = spec.spinInertia;
        rows.push({
          loadout: `${bl.id} / ${d.id} / ${t.id}`,
          mass: r4(bey.body.mass()),
          comY: r4(com.y),
          gameSpin: r4(game),
          rapierIy: r4(I.y),
          rapierIxz: [r4(I.x), r4(I.z)],
          diffPct: Math.round(((game - I.y) / I.y) * 1000) / 10,
        });
        bey.dispose();
        pw.dispose();
      }
  const diffs = rows.map((r) => r.diffPct);
  const summary = {
    combos: rows.length,
    over5pct: rows.filter((r) => Math.abs(r.diffPct) > 5).length,
    diffPct: { min: Math.min(...diffs), max: Math.max(...diffs), mean: Math.round((diffs.reduce((s, v) => s + v, 0) / diffs.length) * 10) / 10 },
    reason:
      '游戏层 Blade / Disc 用 m·r²·rimWeight（rimWeight 0.45–0.8），Rapier 圆柱碰撞体按均匀实心圆柱 ½·m·r²；' +
      '轴心游戏层按 m·r_contact²·0.5，Rapier 为接地球（0.6m，2/5·m·r²）+ 轴杆圆柱（0.4m，r=0.11）。差值来自建模口径，不是数值错误；' +
      'v1 以游戏层标量为准（R12），切换完整张量列为后续研究。',
  };
  log(JSON.stringify(summary, null, 1));
  for (const r of rows) log(JSON.stringify(r));
  mkdirSync('test-results/inertia', { recursive: true });
  writeFileSync('test-results/inertia/contract.json', JSON.stringify({ summary, rows }, null, 1));
}, 120000);
